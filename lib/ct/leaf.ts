/**
 * Parsing CT log entries.
 *
 * A log entry's `leaf_input` is a base64 MerkleTreeLeaf as defined by RFC 6962
 * section 3.4:
 *
 *   version          1 byte
 *   leaf_type        1 byte
 *   timestamp        8 bytes, big-endian, milliseconds
 *   entry_type       2 bytes  (0 = x509_entry, 1 = precert_entry)
 *   -- x509_entry:    24-bit length, then the DER certificate
 *   -- precert_entry: 32-byte issuer_key_hash, 24-bit length, then the TBSCertificate
 *
 * WHY NOT A FULL X.509 PARSER: this pipeline needs exactly two things from a
 * certificate - the dNSNames in its subjectAltName extension, and roughly when
 * it was logged. A complete parser is thousands of lines and a dependency;
 * finding one extension is a bounded walk over DER.
 *
 * Every function here is written to fail closed. Malformed input yields no
 * names rather than wrong ones, because a bad parse that invents a domain would
 * put a fabricated accusation into the pipeline. CT logs contain genuinely
 * malformed certificates - it is why Google maintains a forked x509 package in
 * certificate-transparency-go specifically to tolerate them - so this will be
 * fed garbage regularly and must simply skip it.
 */

export interface CtLeaf {
  /** When the log says it saw this, in epoch milliseconds. */
  timestampMs: number;
  /** 0 = final certificate, 1 = precertificate. */
  entryType: number;
  /** DER of the certificate, or of the TBSCertificate for a precert. */
  der: Buffer;
}

/** OID 2.5.29.17 (subjectAltName), as it appears DER-encoded. */
const SAN_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]);

/** [2] IMPLICIT IA5String inside GeneralName - that is, a dNSName. */
const TAG_DNS_NAME = 0x82;

/** Sanity ceiling. The largest real certificates carry a few thousand SANs;
 *  anything past this is a malformed length field being believed. */
const MAX_NAMES_PER_CERT = 5000;

export function parseLeaf(leafInputBase64: string): CtLeaf | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(leafInputBase64, 'base64');
  } catch {
    return null;
  }

  // 12 bytes of fixed header before any entry-specific data.
  if (buf.length < 15) return null;

  const timestampMs = Number(buf.readBigUInt64BE(2));
  const entryType = buf.readUInt16BE(10);
  if (entryType !== 0 && entryType !== 1) return null;

  // A precert entry carries a 32-byte issuer key hash before the length.
  let off = 12 + (entryType === 1 ? 32 : 0);
  if (off + 3 > buf.length) return null;

  const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
  off += 3;
  if (len <= 0 || off + len > buf.length) return null;

  return { timestampMs, entryType, der: buf.subarray(off, off + len) };
}

/**
 * Pull the dNSNames out of a certificate's subjectAltName extension.
 *
 * Finds the extension by scanning for its OID rather than walking the whole
 * certificate structure. That is deliberate: it works identically on a full
 * certificate and on the bare TBSCertificate that precert entries carry, and it
 * does not care about the many ways real certificates deviate from the spec
 * elsewhere in the structure.
 *
 * The theoretical cost is a false positive - those five OID bytes could appear
 * inside a key or a signature by coincidence. The parse that follows then has
 * to find a well-formed OCTET STRING wrapping a SEQUENCE of GeneralNames, and
 * anything that fails is skipped, so a coincidental match yields nothing.
 */
export function extractDnsNames(der: Buffer): string[] {
  const names: string[] = [];
  let searchFrom = 0;

  while (names.length < MAX_NAMES_PER_CERT) {
    const at = der.indexOf(SAN_OID, searchFrom);
    if (at === -1) break;
    searchFrom = at + SAN_OID.length;

    let off = at + SAN_OID.length;

    // Optional BOOLEAN `critical` between the OID and the value.
    if (der[off] === 0x01) {
      const [boolLen, boolHdr] = readLength(der, off + 1);
      if (boolLen < 0) continue;
      off += 1 + boolHdr + boolLen;
    }

    // extnValue is an OCTET STRING wrapping the GeneralNames SEQUENCE.
    if (der[off] !== 0x04) continue;
    const [, octetHdr] = readLength(der, off + 1);
    off += 1 + octetHdr;

    if (der[off] !== 0x30) continue;
    const [seqLen, seqHdr] = readLength(der, off + 1);
    if (seqLen < 0) continue;

    let p = off + 1 + seqHdr;
    const end = Math.min(p + seqLen, der.length);

    while (p < end && names.length < MAX_NAMES_PER_CERT) {
      const tag = der[p];
      const [len, hdr] = readLength(der, p + 1);
      if (len < 0) break;
      const valueAt = p + 1 + hdr;
      if (valueAt + len > der.length) break;

      if (tag === TAG_DNS_NAME) {
        // IA5String is ASCII. Punycode labels stay encoded, which is what the
        // matcher wants - it decodes them itself so it can see the homoglyphs.
        const name = der.subarray(valueAt, valueAt + len).toString('latin1');
        if (isPlausibleDnsName(name)) names.push(name);
      }

      p = valueAt + len;
    }
  }

  return names;
}

/**
 * Read a DER length at `off`. Returns `[length, headerBytes]`, or `[-1, 1]` for
 * anything unreasonable. Lengths above four bytes are rejected rather than
 * supported: no legitimate certificate field is 4GB, and believing a corrupt
 * length is how a parser starts reading arbitrary memory as a domain name.
 */
function readLength(buf: Buffer, off: number): [number, number] {
  if (off >= buf.length) return [-1, 1];

  const first = buf[off];
  if (first < 0x80) return [first, 1];

  const count = first & 0x7f;
  if (count === 0 || count > 4 || off + 1 + count > buf.length) return [-1, 1];

  let len = 0;
  for (let i = 0; i < count; i++) len = len * 256 + buf[off + 1 + i];
  return [len, 1 + count];
}

/** Cheap shape check before a name is trusted enough to hand downstream. */
function isPlausibleDnsName(name: string): boolean {
  if (name.length < 4 || name.length > 253) return false;
  if (!name.includes('.')) return false;
  // Wildcards are normal in SANs; everything else outside the hostname
  // character set means the parse went wrong.
  return /^[a-zA-Z0-9.*_-]+$/.test(name);
}
