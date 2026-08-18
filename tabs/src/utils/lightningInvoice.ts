import { decode } from 'light-bolt11-decoder';

export interface ParsedInvoice {
  amountSats: number;
  memo: string | null;
}

export const parseInvoice = (paymentRequest: string): ParsedInvoice => {
  const decodedInvoice = decode(paymentRequest);
  const amountSection = decodedInvoice.sections.find(
    section => section.name === 'amount',
  );
  const descriptionSection = decodedInvoice.sections.find(
    section => section.name === 'description',
  );
  const amountMsat =
    amountSection?.name === 'amount' ? Number(amountSection.value) : NaN;

  if (!Number.isFinite(amountMsat) || amountMsat <= 0) {
    throw new Error('The invoice must include an amount.');
  }

  return {
    amountSats: amountMsat / 1000,
    memo:
      descriptionSection?.name === 'description'
        ? descriptionSection.value
        : null,
  };
};
