export interface Sender {
  walletAddress: string;
  privateKey: string;
}

export interface SenderPublic {
  walletAddress: string;
}

export function toPublic(sender: Sender): SenderPublic {
  const { privateKey: _, ...pub } = sender;
  return pub;
}
