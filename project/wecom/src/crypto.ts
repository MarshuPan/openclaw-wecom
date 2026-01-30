export function computeWecomMsgSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
}): string {
  void params;
  // TODO: implement SHA1 signature
  return "";
}

export function verifyWecomSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
  signature: string;
}): boolean {
  void params;
  // TODO: implement signature verification
  return false;
}

export function decryptWecomEncrypted(params: {
  encodingAESKey: string;
  receiveId: string;
  encrypt: string;
}): string {
  void params;
  // TODO: implement AES-256-CBC decrypt
  return "";
}

export function encryptWecomPlaintext(params: {
  encodingAESKey: string;
  receiveId: string;
  plaintext: string;
}): string {
  void params;
  // TODO: implement AES-256-CBC encrypt
  return "";
}
