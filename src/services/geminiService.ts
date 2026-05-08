import { GoogleGenAI, Type } from "@google/genai";

export interface Invoice {
  invoiceNumber: string;
  date: string;
  client: string;
  amountUSD: number;
}

export const INVOICE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      invoiceNumber: { type: Type.STRING },
      date: { type: Type.STRING },
      client: { type: Type.STRING },
      amountUSD: { type: Type.NUMBER },
    },
    required: ["invoiceNumber", "date", "client", "amountUSD"],
  },
};

const EXTRACTION_PROMPT = `You are a financial document parser for შპს პასკი (a Georgian hotel/hospitality company).

Extract invoice details from these PDF documents. For EACH invoice found, return:
- invoiceNumber: The invoice number (e.g., "070201", "121202"). Look for patterns like "Invoice #", "ინვოისი", "INV", or 6-digit date codes (DDMMYY format).
- date: Invoice date in YYYY-MM-DD format. Convert from DD.MM.YYYY if needed.
- client: The client/company name. Look for "Attention to", "Bill to", or company name near the top.
- amountUSD: Total amount in USD. Look for "Total:", "Grand Total:", "$". If only GEL amount exists, divide by 2.7 to estimate USD.

Important:
- If one PDF contains multiple invoices, extract ALL of them.
- Invoice numbers are often 6-digit date codes like 070201 (meaning 07.02.01 or Feb 7).
- The client field should contain the tour operator / travel agency name, NOT the hotel guest name.
- Return an array of objects, even if only one invoice is found.`;

// --- Rate limit configuration ---
const BATCH_SIZE = 2;
const BASE_DELAY_MS = 4000;
const MAX_RETRIES = 3;
const BACKOFF_MULTIPLIER = 2;

// FIX: gemini-3-flash-preview does not exist. Use the correct model name.
const MODEL = "gemini-2.0-flash";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function callWithRetry(
  ai: GoogleGenAI,
  parts: any[],
  retries = MAX_RETRIES
): Promise<Invoice[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            parts: [
              ...parts,
              { text: EXTRACTION_PROMPT },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: INVOICE_SCHEMA,
        },
      });

      if (response.text) {
        const parsed = JSON.parse(response.text) as Invoice[];
        return parsed
          .filter(inv => inv.amountUSD > 0 && inv.invoiceNumber)
          .map(inv => ({
            invoiceNumber: inv.invoiceNumber.trim(),
            date: inv.date || '',
            client: inv.client?.trim() || 'Unknown',
            amountUSD: Math.round(inv.amountUSD * 100) / 100,
          }));
      }
      return [];
    } catch (err: any) {
      const status = err?.status || err?.httpErrorCode || err?.error?.code;
      const msg = err?.message || JSON.stringify(err);
      const isRateLimit =
        status === 429 ||
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('quota');

      if (isRateLimit && attempt < retries) {
        const waitTime = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt + 1);
        console.warn(`⏳ Rate limit (attempt ${attempt + 1}/${retries}). Waiting ${waitTime / 1000}s...`);
        await sleep(waitTime);
        continue;
      }

      console.error(`❌ API error (attempt ${attempt + 1}):`, msg);
      throw err;
    }
  }
  return [];
}

export async function processInvoiceBatch(
  files: File[],
  onProgress?: (progress: number) => void,
  onStatus?: (msg: string) => void,
): Promise<Invoice[]> {
  // vite.config.ts defines process.env.GEMINI_API_KEY at build time via loadEnv
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || apiKey.trim() === '' || apiKey === 'AIzaSyCw0Zh6Wbc8aItK70Z54Y4e_cbJOJA_Hgk') {
    throw new Error(
      "Gemini API Key არ არის კონფიგურირებული.\n\n" +
      "Vercel-ზე: Settings → Environment Variables → GEMINI_API_KEY\n" +
      "ლოკალურად: .env.local → GEMINI_API_KEY=შენი_გასაღები"
    );
  }

  const ai = new GoogleGenAI({ apiKey });
  const results: Invoice[] = [];
  const errors: string[] = [];
  const total = files.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const batchNames = batch.map(f => f.name).join(', ');
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(total / BATCH_SIZE);

    onStatus?.(`ბეჩი ${batchNum}/${totalBatches}: ${batchNames}`);

    try {
      const parts = await Promise.all(
        batch.map(async (file) => {
          const base64 = await fileToBase64(file);
          return {
            inlineData: {
              mimeType: "application/pdf" as const,
              data: base64.split(",")[1],
            },
          };
        })
      );

      const parsed = await callWithRetry(ai, parts);
      results.push(...parsed);
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error(`❌ ${batchNames}: ${msg}`);
      errors.push(batchNames);
    }

    const processed = Math.min(i + batch.length, total);
    onProgress?.(Math.round((processed / total) * 100));

    if (i + BATCH_SIZE < total) {
      onStatus?.(`⏳ ${BASE_DELAY_MS / 1000}წ ლოდინი (rate limit)...`);
      await sleep(BASE_DELAY_MS);
    }
  }

  if (errors.length > 0) {
    console.warn(`⚠️ ${errors.length} batch failed:`, errors);
  }

  return results;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
}