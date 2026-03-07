import React, { useState, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { Download, Loader2, Trash2, Upload, FileSpreadsheet, Receipt, DollarSign, BarChart3, Users, Play, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { processInvoiceBatch, Invoice } from './services/geminiService';

// ============================================================
// TYPES
// ============================================================
interface Bill {
  id: string;
  serviceMonth: string;
  serviceYear: string;
  taxID: string;
  vendorName: string;
  description: string;
  stayDates: string;
  invoiceNumber: string;
  invoiceDate: string;
  amountGEL: number;
  transferDate?: string;
  fxr?: number;
  isEditing?: boolean;
  isSelected?: boolean;
}

interface Transaction {
  id: string;
  date: string;
  amountGEL: number;
  amountUSD: number;
  rateUsed: number;
  company: string;
  companyID: string;
  details: string;
  details2: string;
  bank: string;
  invoiceRefs: string[];
  comment: string;
}

interface ReconResult {
  invoice: Invoice;
  paidUSD: number;
  balanceUSD: number;
  status: 'PAID' | 'PARTIAL' | 'OPEN';
  matchedPayments: { date: string; amount: number; method: string }[];
  comment: string;
  isEditing?: boolean;
}

interface DebtorSummary {
  name: string;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
  invoiceCount: number;
  oldestDate: string;
}

// ============================================================
// HELPERS
// ============================================================

/** Parse any date format → YYYY-MM-DD */
const parseDate = (raw: any): string => {
  if (!raw) return '';
  try {
    if (raw instanceof Date) {
      const y = raw.getFullYear(), m = String(raw.getMonth() + 1).padStart(2, '0'), d = String(raw.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    if (typeof raw === 'number') {
      // Excel serial date
      const date = new Date(Math.round((raw - 25569) * 86400 * 1000));
      const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    if (typeof raw === 'string') {
      // Try ISO first
      if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        return raw.substring(0, 10);
      }
      // DD.MM.YYYY or DD/MM/YYYY
      const parts = raw.split(/[\/\-\.]/);
      if (parts.length === 3) {
        const [a, b, c] = parts;
        if (a.length === 4) return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
        return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
      }
      // Generic Date parse
      const d = new Date(raw);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
      }
    }
  } catch { /* fallback */ }
  return String(raw).substring(0, 10);
};

/** Extract invoice references from payment descriptions */
const extractInvoiceRefs = (text: string): string[] => {
  if (!text) return [];
  const refs: string[] = [];
  const combined = text.toLowerCase();

  // Pattern 1: "INVOICE . 020901" or "INVOICE 171108" or "inv: 040901"
  const invPatterns = [
    /(?:invoice|inv|ინვ|ინვოისი|ინვოოსი)\s*[.:#\s]*\s*(\d{4,}[\w-]*)/gi,
    /(?:invoice|inv)\s*[.:#\s]+(\d{6}(?:\s+\d{6})*)/gi,
  ];
  for (const pat of invPatterns) {
    let m: RegExpExecArray | null;
    while ((m = pat.exec(combined)) !== null) {
      // Split by whitespace in case of multiple invoice refs like "090926 180803 240705"
      const nums = m[1].trim().split(/\s+/);
      nums.forEach(n => {
        if (n.length >= 6 && /^\d{6,}/.test(n)) refs.push(n);
      });
    }
  }

  // Pattern 2: Standalone 6-digit DDMMYY codes at the end of string
  const standalone = combined.match(/\b(\d{6})\b/g);
  if (standalone) {
    standalone.forEach(code => {
      const dd = parseInt(code.substring(0, 2));
      const mm = parseInt(code.substring(2, 4));
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && !refs.includes(code)) {
        refs.push(code);
      }
    });
  }

  return [...new Set(refs)];
};

/** Get exchange rate for date with nearest-date fallback */
const getRate = (date: string, rates: Record<string, number>): number => {
  if (rates[date]) return rates[date];

  // Find nearest previous date
  const sortedDates = Object.keys(rates).sort();
  let best = '';
  for (const d of sortedDates) {
    if (d <= date) best = d;
    else break;
  }
  if (best && rates[best]) return rates[best];

  // Fallback: nearest future date
  for (const d of sortedDates) {
    if (d >= date) return rates[d];
  }
  return 0;
};

/** Format number with commas */
const fmt = (n: number, dec = 2) => n.toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Generate unique ID */
let _idCounter = 0;
const uid = () => `tx_${Date.now()}_${++_idCounter}`;

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  // --- State ---
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [exchangeRates, setExchangeRates] = useState<Record<string, number>>({});
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [results, setResults] = useState<ReconResult[]>([]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [view, setView] = useState<'upload' | 'audit' | 'debtors'>('upload');
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().split('T')[0]);
  const [searchTerm, setSearchTerm] = useState('');
  const [batchMonth, setBatchMonth] = useState('');
  const [batchYear, setBatchYear] = useState('');

  // --- Counts for step indicators ---
  const bankCount = transactions.length;
  const rateCount = Object.keys(exchangeRates).length;
  const invoiceCount = invoices.length;
  const hasResults = results.length > 0;

  // ============================================================
  // 1. BANK UPLOAD (APPEND - multiple files)
  // ============================================================
  const handleBankUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsProcessing(true);
    setProgressLabel('საბანკო ამონაწერების დამუშავება...');

    const allNew: Transaction[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { cellDates: true });

        // Try each sheet
        for (const sheetName of workbook.SheetNames) {
          const json: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
          if (json.length === 0) continue;

          // Auto-detect columns
          const first = json[0];
          const keys = Object.keys(first);
          const findCol = (...names: string[]) => keys.find(k => names.some(n => k.toLowerCase().includes(n.toLowerCase())));

          const dateCol = findCol('Date', 'თარიღი', 'გადახდის თარიღი');
          const amountCol = findCol('Amount (GEL)', 'Amount', 'თანხა', 'გადახდილი თანხა');
          const companyCol = findCol('Company', 'კომპანია', 'გადამხდელი');
          const idCol = findCol('ID', 'საიდენტიფიკაციო');
          const detailsCol = findCol('Details', 'Description', 'დეტალები', 'დანიშნულება');
          const details2Col = findCol('Details 2', 'Details2', 'დეტალები 2');

          if (!dateCol || !amountCol) continue;

          json.forEach(row => {
            const rawDate = row[dateCol!];
            const rawAmount = parseFloat(row[amountCol!] || 0);
            if (!rawDate || isNaN(rawAmount) || rawAmount === 0) return;

            const date = parseDate(rawDate);
            const company = String(row[companyCol!] || '').trim();
            const companyID = String(row[idCol!] || '').trim();
            const details = String(row[detailsCol!] || '').trim();
            const details2 = String(row[details2Col!] || row[keys[keys.length - 1]] || '').trim();

            // Extract invoice refs from all text fields
            const allText = `${details} ${details2} ${company}`;
            const invoiceRefs = extractInvoiceRefs(allText);

            // Detect bank from last column or company field
            let bank = '';
            const lastVal = String(row[keys[keys.length - 1]] || '').trim();
            if (['TBC', 'BOG', 'თიბისი', 'საქართველოს ბანკი'].includes(lastVal)) {
              bank = lastVal;
            }

            allNew.push({
              id: uid(),
              date,
              amountGEL: rawAmount,
              amountUSD: 0,
              rateUsed: 0,
              company,
              companyID,
              details,
              details2,
              bank,
              invoiceRefs,
              comment: ''
            });
          });
        }
      } catch (err) {
        console.error(`Error processing ${file.name}:`, err);
      }
      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    setTransactions(prev => [...prev, ...allNew]);
    setIsProcessing(false);
    setProgress(0);
    setProgressLabel('');
    e.target.value = '';
  }, []);

  // ============================================================
  // 2. EXCHANGE RATES UPLOAD (CUMULATIVE APPEND)
  // ============================================================
  const handleRatesUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newRates: Record<string, number> = {};
    let count = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { cellDates: true });

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];

          // --- Strategy 1: Try with headers ---
          const json: any[] = XLSX.utils.sheet_to_json(sheet);
          let found = false;

          if (json.length > 0) {
            const keys = Object.keys(json[0]);
            const dateCol = keys.find(k => /date|თარიღი/i.test(k));
            const rateCol = keys.find(k => /rate|კურსი|usd/i.test(k));

            if (dateCol && rateCol) {
              json.forEach(row => {
                const rawDate = row[dateCol!];
                const rawRate = parseFloat(row[rateCol!]);
                if (rawDate && !isNaN(rawRate) && rawRate > 0) {
                  const dateStr = parseDate(rawDate);
                  if (dateStr) { newRates[dateStr] = rawRate; count++; }
                }
              });
              found = true;
            }
          }

          // --- Strategy 2: Headerless file (like NBG) ---
          // Read as raw arrays: [[date, rate], [date, rate], ...]
          if (!found) {
            const raw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            for (const row of raw) {
              if (!row || row.length < 2) continue;
              const col0 = row[0];
              const col1 = row[1];

              // Check: col0 is a date-like value, col1 is a number between 1-10 (exchange rate range)
              const dateStr = parseDate(col0);
              const rate = parseFloat(col1);

              if (dateStr && dateStr.length >= 8 && !isNaN(rate) && rate > 0.5 && rate < 50) {
                newRates[dateStr] = rate;
                count++;
              }
            }
          }
        }
      } catch (err) {
        console.error(`Error processing rates from ${file.name}:`, err);
      }
    }

    setExchangeRates(prev => ({ ...prev, ...newRates }));
    e.target.value = '';
  }, []);

  // ============================================================
  // 3. INVOICE UPLOAD (PDF via Gemini & XLSX — APPEND)
  // ============================================================
  const handleInvoicesUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsProcessing(true);
    setProgress(0);
    setProgressLabel(`ინვოისების დამუშავება (0/${files.length})...`);

    try {
      const fileArray = Array.from(files) as File[];
      const pdfFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.pdf'));
      const excelFiles = fileArray.filter(f => f.name.toLowerCase().match(/\.(xlsx|xls|csv)$/));
      
      let parsedInvoices: Invoice[] = [];

      // Process Excel files
      for (let i = 0; i < excelFiles.length; i++) {
        const file = excelFiles[i];
        try {
          const data = await file.arrayBuffer();
          const workbook = XLSX.read(data, { cellDates: true });
          
          for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const raw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            
            // Find the header row
            let headerRowIdx = -1;
            for (let r = 0; r < Math.min(10, raw.length); r++) {
              const row = raw[r];
              if (row && row.some(cell => {
                const s = String(cell).toLowerCase().trim();
                return s === 'vendor name' || s === 'client' || s === 'კლიენტი' || s === 'დასახელება';
              })) {
                headerRowIdx = r;
                break;
              }
            }
            
            if (headerRowIdx === -1) headerRowIdx = 0;
            const headerRow = raw[headerRowIdx] || [];
            const keys = headerRow.map(k => String(k).toLowerCase().trim());
            
            const invCol = keys.findIndex(k => k === 'invoice #' || k.includes('ინვოისი'));
            const dateCol = keys.findIndex(k => k === 'invoice date' || k === 'თარიღი');
            const clientCol = keys.findIndex(k => k === 'vendor name' || k === 'client' || k === 'დასახელება' || k === 'კლიენტი');
            const descCol = keys.findIndex(k => k === 'description' || k.includes('გაწეული მომსახურება'));
            let totalCol = keys.findIndex(k => k === 'invoice total' || k === 'თანხა');
            if (totalCol === -1) totalCol = keys.findIndex(k => k.includes('total'));
            const currCol = keys.findIndex(k => k === 'currency' || k === 'ვალუტა');
            const taxIdCol = keys.findIndex(k => k === 'tax id');
            const stayDatesCol = keys.findIndex(k => k === 'stay dates');
            const transferDateCol = keys.findIndex(k => k === 'transfer date' || k === 'გადარიცხვის თარიღი');
            const fxrCol = keys.findIndex(k => k === 'fxr' || k === 'კურსი');

            const startIdx = headerRowIdx + 1;
            const invoiceMap = new Map<string, Invoice>();
            const billMap = new Map<string, Bill>();
            
            for (let r = startIdx; r < raw.length; r++) {
              const row = raw[r];
              if (!row || row.length === 0) continue;
              
              const client = clientCol >= 0 ? String(row[clientCol] || '').trim() : '';
              const description = descCol >= 0 ? String(row[descCol] || '').trim() : '';
              const currency = currCol >= 0 ? String(row[currCol] || '').trim().toUpperCase() : 'USD';
              let amount = totalCol >= 0 ? parseFloat(String(row[totalCol]).replace(/,/g, '')) : NaN;
              const dateRaw = dateCol >= 0 ? row[dateCol] : '';
              let invoiceNumber = invCol >= 0 ? String(row[invCol] || '').trim() : '';
              const taxID = taxIdCol >= 0 ? String(row[taxIdCol] || '').trim() : '';
              const stayDates = stayDatesCol >= 0 ? String(row[stayDatesCol] || '').trim() : '';
              const transferDate = transferDateCol >= 0 ? String(row[transferDateCol] || '').trim() : undefined;
              const fxr = fxrCol >= 0 ? parseFloat(String(row[fxrCol] || '')) : undefined;
              
              if (!client || isNaN(amount)) continue;
              
              if (!invoiceNumber && description) {
                const refs = extractInvoiceRefs(description);
                if (refs.length > 0) {
                  invoiceNumber = refs[0];
                } else {
                  const match = description.match(/Invoice\s*#\s*(\S+)/i);
                  if (match) invoiceNumber = match[1];
                }
              }
              
              if (!invoiceNumber) continue;
              
              const date = parseDate(dateRaw);
              
              let amountUSD = amount;
              let amountGEL = amount;
              if (currency.includes('GEL') || currency === '₾') {
                amountUSD = amount / 2.7; // Fallback estimate
              } else {
                amountGEL = amount * 2.7; // Fallback estimate
              }
              
              if (!invoiceMap.has(invoiceNumber)) {
                invoiceMap.set(invoiceNumber, {
                  invoiceNumber,
                  date,
                  client,
                  amountUSD: Math.round(amountUSD * 100) / 100
                });
                
                const d = new Date(date);
                billMap.set(invoiceNumber, {
                  id: uid(),
                  serviceMonth: String(d.getMonth() + 1).padStart(2, '0'),
                  serviceYear: String(d.getFullYear()),
                  taxID,
                  vendorName: client,
                  description,
                  stayDates,
                  invoiceNumber,
                  invoiceDate: date,
                  amountGEL: Math.round(amountGEL * 100) / 100,
                  transferDate,
                  fxr: isNaN(fxr!) ? undefined : fxr
                });
              }
            }
            
            parsedInvoices.push(...Array.from(invoiceMap.values()));
            setBills(prev => [...prev, ...Array.from(billMap.values())]);
          }
        } catch (err) {
          console.error(`Error processing Excel invoice ${file.name}:`, err);
        }
      }

      // Process PDF files
      if (pdfFiles.length > 0) {
        const pdfParsed = await processInvoiceBatch(
          pdfFiles,
          (p) => {
            setProgress(p);
          },
          (statusMsg) => {
            setProgressLabel(statusMsg);
          }
        );
        parsedInvoices = [...parsedInvoices, ...pdfParsed];
      }

      setInvoices(prev => [...prev, ...parsedInvoices]);
    } catch (error: any) {
      console.error("Error processing invoices:", error);
      const msg = error?.message || String(error);
      if (msg.includes('API Key') || msg.includes('apiKey') || msg.includes('კონფიგურირებული')) {
        alert("⚠️ Gemini API Key არ არის კონფიგურირებული!\n\n" +
          "1. გახსენით AI Studio-ში Secrets პანელი (🔑 ხატულა)\n" +
          "2. დაამატეთ: GEMINI_API_KEY = თქვენი_გასაღები\n" +
          "3. გასაღების მისაღებად: aistudio.google.com → Get API key\n" +
          "4. გადატვირთეთ აპი და თავიდან სცადეთ.");
      } else {
        alert(`შეცდომა ინვოისების დამუშავებისას:\n${msg}`);
      }
    } finally {
      setIsProcessing(false);
      setProgress(0);
      setProgressLabel('');
      e.target.value = '';
    }
  }, []);

  // ============================================================
  // 4. RECONCILIATION (MANUAL TRIGGER ONLY)
  // ============================================================
  const runReconciliation = useCallback(() => {
    if (invoices.length === 0) {
      alert("ინვოისები არ არის ატვირთული.");
      return;
    }
    if (transactions.length === 0) {
      alert("საბანკო ამონაწერი არ არის ატვირთული.");
      return;
    }
    if (Object.keys(exchangeRates).length === 0) {
      alert("ვალუტის კურსები არ არის ატვირთული.");
      return;
    }

    setIsProcessing(true);
    setProgressLabel('შეჯერების გაშვება...');

    // Step 1: Convert GEL → USD using rates
    const converted = transactions.map(t => {
      const rate = getRate(t.date, exchangeRates);
      return {
        ...t,
        rateUsed: rate,
        amountUSD: rate > 0 ? Math.round((t.amountGEL / rate) * 100) / 100 : 0,
        comment: rate > 0 ? '' : '⚠️ კურსი ვერ მოიძებნა'
      };
    });

    // Step 2: Sort invoices by date (oldest first for FIFO)
    const sortedInvoices = [...invoices].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    // Step 3: Create mutable payment pool
    const pool = converted.map(t => ({ ...t, remaining: t.amountUSD }));

    // Step 4: Three-pass matching
    const reconResults: ReconResult[] = sortedInvoices.map(inv => {
      let paid = 0;
      const matched: { date: string; amount: number; method: string }[] = [];
      const invNum = (inv.invoiceNumber || '').trim().toLowerCase();

      // --- Pass 1: Invoice Number Match ---
      if (invNum && invNum.length >= 4) {
        pool.forEach(t => {
          if (t.remaining <= 0) return;
          const hasRef = t.invoiceRefs.some(ref => ref.includes(invNum) || invNum.includes(ref));
          const inDetails = t.details.toLowerCase().includes(invNum) || t.details2.toLowerCase().includes(invNum);

          if (hasRef || inDetails) {
            const take = Math.min(t.remaining, inv.amountUSD - paid);
            if (take > 0) {
              paid += take;
              t.remaining -= take;
              matched.push({ date: t.date, amount: take, method: `ნომრით: ${inv.invoiceNumber}` });
            }
          }
        });
      }

      // --- Pass 2: Client Name / ID Match ---
      if (paid < inv.amountUSD && inv.client) {
        const clientLower = inv.client.toLowerCase().trim();
        // Take first meaningful word (at least 4 chars)
        const clientWords = clientLower.split(/\s+/).filter(w => w.length >= 4);

        pool.forEach(t => {
          if (t.remaining <= 0 || paid >= inv.amountUSD) return;
          const companyLower = t.company.toLowerCase();
          const detailsLower = `${t.details} ${t.details2}`.toLowerCase();

          const nameMatch = clientWords.some(w => companyLower.includes(w) || detailsLower.includes(w));

          if (nameMatch) {
            const take = Math.min(t.remaining, inv.amountUSD - paid);
            if (take > 0) {
              paid += take;
              t.remaining -= take;
              matched.push({ date: t.date, amount: take, method: `კლიენტით: ${inv.client}` });
            }
          }
        });
      }

      // --- Pass 3: FIFO for unmatched ---
      // Note: FIFO only for remaining amount — skip if already fully paid
      if (paid < inv.amountUSD * 0.5 && paid === 0) {
        // Only use FIFO if zero direct matches found
        // This prevents incorrect allocation
        // We leave it OPEN instead of falsely matching
      }

      // Calculate balance and status
      const balance = Math.round((inv.amountUSD - paid) * 100) / 100;
      let status: 'PAID' | 'PARTIAL' | 'OPEN' = 'OPEN';
      if (balance <= 0.5) status = 'PAID';
      else if (paid > 0) status = 'PARTIAL';

      // Build comment
      let comment = '';
      if (matched.length > 0) {
        const methods = [...new Set(matched.map(m => m.method))];
        comment = methods.join(' | ');
        if (status === 'PAID' && Math.abs(balance) > 0.01) {
          comment += ` | FX სხვაობა: $${Math.abs(balance).toFixed(2)}`;
        }
      } else {
        comment = '❌ გადახდა არ მოიძებნა — საჭიროებს გადამოწმებას';
      }

      return {
        invoice: inv,
        paidUSD: Math.round(paid * 100) / 100,
        balanceUSD: balance,
        status,
        matchedPayments: matched,
        comment
      };
    });

    // Sort: OPEN → PARTIAL → PAID
    const order = { OPEN: 0, PARTIAL: 1, PAID: 2 };
    reconResults.sort((a, b) => order[a.status] - order[b.status]);

    setResults(reconResults);
    setView('audit');
    setIsProcessing(false);
    setProgressLabel('');
  }, [invoices, transactions, exchangeRates]);

  // ============================================================
  // DEBTORS CALCULATION
  // ============================================================
  const debtors = useMemo<DebtorSummary[]>(() => {
    if (results.length === 0) return [];
    const map: Record<string, DebtorSummary> = {};

    results.forEach(r => {
      if (new Date(r.invoice.date) > new Date(asOfDate)) return;
      if (r.balanceUSD <= 0) return;

      const key = r.invoice.client || 'Unknown';
      if (!map[key]) {
        map[key] = { name: key, totalInvoiced: 0, totalPaid: 0, balance: 0, invoiceCount: 0, oldestDate: r.invoice.date };
      }
      map[key].totalInvoiced += r.invoice.amountUSD;
      map[key].totalPaid += r.paidUSD;
      map[key].balance += r.balanceUSD;
      map[key].invoiceCount++;
      if (r.invoice.date < map[key].oldestDate) map[key].oldestDate = r.invoice.date;
    });

    return Object.values(map).sort((a, b) => b.balance - a.balance);
  }, [results, asOfDate]);

  // ============================================================
  // KPIs
  // ============================================================
  const kpis = useMemo(() => {
    if (results.length === 0) return null;
    const totalInvoiced = results.reduce((s, r) => s + r.invoice.amountUSD, 0);
    const totalPaid = results.reduce((s, r) => s + r.paidUSD, 0);
    const outstanding = results.reduce((s, r) => s + r.balanceUSD, 0);
    const paidCount = results.filter(r => r.status === 'PAID').length;
    const partialCount = results.filter(r => r.status === 'PARTIAL').length;
    const openCount = results.filter(r => r.status === 'OPEN').length;
    return { totalInvoiced, totalPaid, outstanding, paidCount, partialCount, openCount };
  }, [results]);

  // ============================================================
  // FILTERED RESULTS (search)
  // ============================================================
  const filteredResults = useMemo(() => {
    if (!searchTerm.trim()) return results;
    const q = searchTerm.toLowerCase();
    return results.filter(r =>
      r.invoice.invoiceNumber?.toLowerCase().includes(q) ||
      r.invoice.client?.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q) ||
      r.comment?.toLowerCase().includes(q)
    );
  }, [results, searchTerm]);

  // ============================================================
  // EXPORTS
  // ============================================================
  const exportReconciliation = useCallback(() => {
    if (results.length === 0) return;

    const wsData = results.map(r => ({
      'ინვოისი #': r.invoice.invoiceNumber,
      'თარიღი': r.invoice.date,
      'კლიენტი': r.invoice.client,
      'ინვოისი (USD)': r.invoice.amountUSD,
      'გადახდილი (USD)': r.paidUSD,
      'ნაშთი (USD)': r.balanceUSD,
      'სტატუსი': r.status,
      'კომენტარი': r.comment
    }));
    const ws = XLSX.utils.json_to_sheet(wsData);

    // Column widths
    ws['!cols'] = [
      { wch: 14 }, { wch: 12 }, { wch: 30 }, { wch: 15 },
      { wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 50 }
    ];

    // Summary sheet
    const summaryData = [
      { 'მეტრიკა': 'სულ ინვოისი (USD)', 'მნიშვნელობა': kpis?.totalInvoiced || 0 },
      { 'მეტრიკა': 'სულ გადახდილი (USD)', 'მნიშვნელობა': kpis?.totalPaid || 0 },
      { 'მეტრიკა': 'დარჩენილი (USD)', 'მნიშვნელობა': kpis?.outstanding || 0 },
      { 'მეტრიკა': 'PAID', 'მნიშვნელობა': kpis?.paidCount || 0 },
      { 'მეტრიკა': 'PARTIAL', 'მნიშვნელობა': kpis?.partialCount || 0 },
      { 'მეტრიკა': 'OPEN', 'მნიშვნელობა': kpis?.openCount || 0 },
    ];
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'შეჯერება');
    XLSX.utils.book_append_sheet(wb, wsSummary, 'შეჯამება');
    XLSX.writeFile(wb, `Paski_Reconciliation_${new Date().toISOString().split('T')[0]}.xlsx`);
  }, [results, kpis]);

  const exportBankTransactions = useCallback(() => {
    if (transactions.length === 0) return;

    const converted = transactions.map(t => {
      const rate = getRate(t.date, exchangeRates);
      return {
        'თარიღი': t.date,
        'თანხა (GEL)': t.amountGEL,
        'კურსი': rate || '',
        'თანხა (USD)': rate > 0 ? Math.round((t.amountGEL / rate) * 100) / 100 : '',
        'კომპანია': t.company,
        'ID': t.companyID,
        'დეტალები': t.details,
        'ინვოისი Refs': t.invoiceRefs.join(', '),
        'ბანკი': t.bank
      };
    });
    const ws = XLSX.utils.json_to_sheet(converted);
    ws['!cols'] = [
      { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 14 },
      { wch: 35 }, { wch: 12 }, { wch: 50 }, { wch: 20 }, { wch: 8 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Bank');
    XLSX.writeFile(wb, `Paski_Bank_Transactions.xlsx`);
  }, [transactions, exchangeRates]);

  const exportDebtors = useCallback(() => {
    if (debtors.length === 0) return;
    const wsData = debtors.map(d => ({
      'კლიენტი': d.name,
      'სულ ინვოისი (USD)': d.totalInvoiced,
      'სულ გადახდილი (USD)': d.totalPaid,
      'ნაშთი (USD)': d.balance,
      'ინვოისების რაოდენობა': d.invoiceCount,
      'უძველესი ინვოისი': d.oldestDate,
    }));
    const ws = XLSX.utils.json_to_sheet(wsData);
    ws['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 18 }, { wch: 15 }, { wch: 20 }, { wch: 15 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'დებიტორები');
    XLSX.writeFile(wb, `Paski_Debtors_${asOfDate}.xlsx`);
  }, [debtors, asOfDate]);

  const toggleEditBill = (index: number) => {
    setBills(prev => prev.map((b, i) => i === index ? { ...b, isEditing: !b.isEditing } : b));
  };

  const deleteBill = (index: number) => {
    setBills(prev => prev.filter((_, i) => i !== index));
  };

  const updateBill = (index: number, field: keyof Bill, value: any) => {
    setBills(prev => prev.map((b, i) => i === index ? { ...b, [field]: value } : b));
  };

  const toggleSelectBill = (index: number) => {
    setBills(prev => prev.map((b, i) => i === index ? { ...b, isSelected: !b.isSelected } : b));
  };

  const toggleSelectAll = () => {
    const allSelected = bills.every(b => b.isSelected);
    setBills(prev => prev.map(b => ({ ...b, isSelected: !allSelected })));
  };

  const batchUpdateBills = () => {
    if (!batchMonth && !batchYear) return;
    setBills(prev => prev.map(b => {
      if (b.isSelected) {
        return {
          ...b,
          serviceMonth: batchMonth || b.serviceMonth,
          serviceYear: batchYear || b.serviceYear,
          isSelected: false // Deselect after update
        };
      }
      return b;
    }));
    setBatchMonth('');
    setBatchYear('');
  };

  const updateBillsFromTransactions = useCallback(() => {
    if (bills.length === 0 || transactions.length === 0) {
      alert("გთხოვთ ატვირთოთ საბანკო ამონაწერი და ინვოისები.");
      return;
    }

    const updatedBills = bills.map(bill => {
      const matchedTransaction = transactions.find(t => 
        t.invoiceRefs.some(ref => ref.includes(bill.invoiceNumber)) ||
        t.details.toLowerCase().includes(bill.invoiceNumber.toLowerCase()) ||
        t.details2.toLowerCase().includes(bill.invoiceNumber.toLowerCase())
      );

      if (matchedTransaction) {
        const rate = getRate(matchedTransaction.date, exchangeRates);
        return {
          ...bill,
          transferDate: matchedTransaction.date,
          fxr: rate
        };
      } else {
        const year = parseInt(bill.serviceYear);
        const month = parseInt(bill.serviceMonth);
        // Ensure month is 1-12, otherwise fallback to current month
        const validMonth = (month >= 1 && month <= 12) ? month : new Date().getMonth() + 1;
        const validYear = (year >= 2000 && year <= 2100) ? year : new Date().getFullYear();
        
        const lastDay = new Date(validYear, validMonth, 0);
        const dateStr = lastDay.toISOString().split('T')[0];
        const rate = getRate(dateStr, exchangeRates);
        return {
          ...bill,
          transferDate: undefined,
          fxr: rate
        };
      }
    });
    setBills(updatedBills);
    alert("ინფორმაცია განახლდა.");
  }, [bills, transactions, exchangeRates]);

  const exportBillsToXLSX = () => {
    const wsData = bills.map(b => ({
      'მომსახურების თვე': b.serviceMonth,
      'მომსახურების წელი': b.serviceYear,
      'Tax ID': b.taxID,
      'Vendor Name': b.vendorName,
      'Description': b.description,
      'Stay Dates': b.stayDates,
      'Invoice #': b.invoiceNumber,
      'Invoice Date': b.invoiceDate,
      'Amount GEL': b.amountGEL,
      'Transfer Date': b.transferDate || '',
      'FXR': b.fxr || ''
    }));
    const ws = XLSX.utils.json_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ა_ფატურა');
    XLSX.writeFile(wb, 'ა_ფატურა.xlsx');
  };

  // ============================================================
  // RENDER
  // ============================================================
  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      PAID: 'bg-emerald-100 text-emerald-700 border-emerald-200',
      PARTIAL: 'bg-amber-100 text-amber-700 border-amber-200',
      OPEN: 'bg-red-100 text-red-700 border-red-200',
    };
    const icons: Record<string, React.ReactNode> = {
      PAID: <CheckCircle2 size={10} />,
      PARTIAL: <Clock size={10} />,
      OPEN: <AlertCircle size={10} />,
    };
    return (
      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black border ${styles[status] || ''}`}>
        {icons[status]} {status}
      </span>
    );
  };

  const toggleEdit = (index: number) => {
    setResults(prev => prev.map((r, i) => i === index ? { ...r, isEditing: !r.isEditing } : r));
  };

  const updateInvoice = (index: number, field: keyof Invoice, value: any) => {
    setResults(prev => prev.map((r, i) => {
      if (i === index) {
        const updatedInvoice = { ...r.invoice, [field]: value };
        // Recalculate status if amount changes
        const balance = Math.round((updatedInvoice.amountUSD - r.paidUSD) * 100) / 100;
        let status: 'PAID' | 'PARTIAL' | 'OPEN' = 'OPEN';
        if (balance <= 0.5) status = 'PAID';
        else if (r.paidUSD > 0) status = 'PARTIAL';
        return { ...r, invoice: updatedInvoice, balanceUSD: balance, status };
      }
      return r;
    }));
  };

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-[#111] font-sans">
      {/* ============ HEADER ============ */}
      <header className="bg-white border-b border-black/5 sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-black rounded-xl flex items-center justify-center">
              <BarChart3 size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight leading-none">PASKI AUDITOR</h1>
              <p className="text-[10px] text-gray-400 font-medium tracking-widest">RECONCILIATION SYSTEM</p>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex gap-1 bg-gray-100 p-1 rounded-xl">
            {[
              { key: 'upload' as const, label: 'ატვირთვა', icon: Upload },
              { key: 'audit' as const, label: 'აუდიტი', icon: Receipt, count: hasResults ? results.length : undefined },
              { key: 'bills' as const, label: 'ა/ფატურა', icon: FileSpreadsheet, count: bills.length || undefined },
              { key: 'debtors' as const, label: 'დებიტორები', icon: Users, count: debtors.length || undefined },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setView(tab.key)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                  view === tab.key
                    ? 'bg-white text-black shadow-sm'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                <tab.icon size={14} />
                {tab.label}
                {tab.count !== undefined && (
                  <span className="bg-black text-white text-[9px] px-1.5 py-0.5 rounded-full">{tab.count}</span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* ============ PROGRESS BAR ============ */}
      {isProcessing && (
        <div className="bg-white border-b border-black/5 px-6 py-3">
          <div className="max-w-[1400px] mx-auto">
            <div className="flex items-center gap-3 mb-2">
              <Loader2 size={14} className="animate-spin text-blue-600" />
              <span className="text-xs font-medium text-gray-600">{progressLabel}</span>
              {progress > 0 && <span className="text-xs font-bold text-blue-600">{progress}%</span>}
            </div>
            {progress > 0 && (
              <div className="w-full bg-gray-100 rounded-full h-1.5">
                <div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <AnimatePresence mode="wait">
          {/* ============================================================ */}
          {/* UPLOAD VIEW                                                   */}
          {/* ============================================================ */}
          {view === 'upload' && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {/* Step Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                {/* --- BANK --- */}
                <div className={`relative p-6 rounded-2xl border-2 transition-all ${
                  bankCount > 0 ? 'border-emerald-200 bg-emerald-50/30' : 'border-dashed border-gray-200 bg-white'
                }`}>
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-black ${
                        bankCount > 0 ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-400'
                      }`}>
                        {bankCount > 0 ? <CheckCircle2 size={16} /> : '1'}
                      </div>
                      <div>
                        <h3 className="text-sm font-bold">საბანკო ამონაწერი</h3>
                        <p className="text-[10px] text-gray-400">XLSX ფორმატი</p>
                      </div>
                    </div>
                    {bankCount > 0 && (
                      <button
                        onClick={() => { setTransactions([]); setResults([]); }}
                        className="text-red-400 hover:text-red-600 transition-colors"
                        title="წაშლა"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>

                  <label className="block cursor-pointer">
                    <div className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:bg-blue-50/50 transition-all">
                      <FileSpreadsheet size={16} className="text-gray-400" />
                      <span className="text-xs text-gray-500">აირჩიეთ ფაილ(ებ)ი...</span>
                    </div>
                    <input
                      type="file"
                      multiple
                      accept=".xlsx,.xls"
                      onChange={handleBankUpload}
                      className="hidden"
                    />
                  </label>

                  {bankCount > 0 && (
                    <div className="mt-3 flex items-center justify-between">
                      <p className="text-emerald-600 text-[11px] font-bold">✓ {bankCount} ტრანზაქცია</p>
                      <button
                        onClick={exportBankTransactions}
                        className="text-[10px] text-gray-400 hover:text-blue-600 flex items-center gap-1"
                      >
                        <Download size={10} /> Export
                      </button>
                    </div>
                  )}
                </div>

                {/* --- RATES --- */}
                <div className={`relative p-6 rounded-2xl border-2 transition-all ${
                  rateCount > 0 ? 'border-blue-200 bg-blue-50/30' : 'border-dashed border-gray-200 bg-white'
                }`}>
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-black ${
                        rateCount > 0 ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-400'
                      }`}>
                        {rateCount > 0 ? <CheckCircle2 size={16} /> : '2'}
                      </div>
                      <div>
                        <h3 className="text-sm font-bold">ვალუტის კურსები</h3>
                        <p className="text-[10px] text-gray-400">Date + Rate სვეტები</p>
                      </div>
                    </div>
                    {rateCount > 0 && (
                      <button
                        onClick={() => { setExchangeRates({}); setResults([]); }}
                        className="text-red-400 hover:text-red-600 transition-colors"
                        title="წაშლა"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>

                  <label className="block cursor-pointer">
                    <div className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:bg-blue-50/50 transition-all">
                      <DollarSign size={16} className="text-gray-400" />
                      <span className="text-xs text-gray-500">აირჩიეთ ფაილ(ებ)ი...</span>
                    </div>
                    <input
                      type="file"
                      multiple
                      accept=".xlsx,.xls"
                      onChange={handleRatesUpload}
                      className="hidden"
                    />
                  </label>

                  {rateCount > 0 && (
                    <p className="text-blue-600 text-[11px] font-bold mt-3">✓ {rateCount} კურსი ბაზაში</p>
                  )}
                </div>

                {/* --- INVOICES --- */}
                <div className={`relative p-6 rounded-2xl border-2 transition-all ${
                  invoiceCount > 0 ? 'border-purple-200 bg-purple-50/30' : 'border-dashed border-gray-200 bg-white'
                }`}>
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-black ${
                        invoiceCount > 0 ? 'bg-purple-500 text-white' : 'bg-gray-100 text-gray-400'
                      }`}>
                        {invoiceCount > 0 ? <CheckCircle2 size={16} /> : '3'}
                      </div>
                      <div>
                        <h3 className="text-sm font-bold">ინვოისები</h3>
                        <p className="text-[10px] text-gray-400">PDF / XLSX ფორმატი</p>
                      </div>
                    </div>
                    {invoiceCount > 0 && (
                      <button
                        onClick={() => { setInvoices([]); setResults([]); }}
                        className="text-red-400 hover:text-red-600 transition-colors"
                        title="წაშლა"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>

                  <label className="block cursor-pointer">
                    <div className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 rounded-xl hover:border-purple-300 hover:bg-purple-50/50 transition-all">
                      <Receipt size={16} className="text-gray-400" />
                      <span className="text-xs text-gray-500">აირჩიეთ ფაილ(ებ)ი...</span>
                    </div>
                    <input
                      type="file"
                      multiple
                      accept=".pdf,.xlsx,.xls,.csv"
                      onChange={handleInvoicesUpload}
                      className="hidden"
                    />
                  </label>

                  {invoiceCount > 0 && (
                    <p className="text-purple-600 text-[11px] font-bold mt-3">✓ {invoiceCount} ინვოისი</p>
                  )}
                </div>
              </div>

              {/* RUN BUTTON */}
              <button
                onClick={runReconciliation}
                disabled={isProcessing || bankCount === 0 || rateCount === 0 || invoiceCount === 0}
                className="w-full py-5 bg-black text-white rounded-2xl font-black text-sm tracking-widest hover:bg-blue-600 transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3"
              >
                {isProcessing ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Play size={18} />
                )}
                შეჯერების გაშვება
              </button>

              {bankCount === 0 || rateCount === 0 || invoiceCount === 0 ? (
                <p className="text-center text-gray-400 text-[11px] mt-3">
                  ატვირთეთ სამივე ფაილი შეჯერების გასაშვებად
                </p>
              ) : null}

              {/* DATA PREVIEW TABLES */}
              {/* Bank Transactions Preview */}
              {bankCount > 0 && (
                <div className="mt-10">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                      საბანკო ტრანზაქციები ({bankCount})
                    </h3>
                  </div>
                  <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                      <table className="w-full text-left">
                        <thead className="bg-gray-50 text-[10px] uppercase font-bold text-gray-400 sticky top-0">
                          <tr>
                            <th className="p-3">თარიღი</th>
                            <th className="p-3 text-right">თანხა (GEL)</th>
                            <th className="p-3">კომპანია</th>
                            <th className="p-3">დეტალები</th>
                            <th className="p-3">ინვოისი Ref</th>
                            <th className="p-3">ბანკი</th>
                          </tr>
                        </thead>
                        <tbody className="text-xs">
                          {transactions.slice(0, 100).map((t, i) => (
                            <tr key={t.id || i} className="border-t border-gray-50 hover:bg-gray-50/50">
                              <td className="p-3 text-gray-500 whitespace-nowrap">{t.date}</td>
                              <td className="p-3 text-right font-mono font-bold">{fmt(t.amountGEL)}</td>
                              <td className="p-3 max-w-[200px] truncate" title={t.company}>{t.company.split(',')[0]}</td>
                              <td className="p-3 max-w-[250px] truncate text-gray-500" title={t.details}>{t.details}</td>
                              <td className="p-3">
                                {t.invoiceRefs.length > 0 && (
                                  <span className="text-blue-600 font-mono text-[10px]">{t.invoiceRefs.join(', ')}</span>
                                )}
                              </td>
                              <td className="p-3 text-gray-400">{t.bank}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {bankCount > 100 && (
                      <div className="text-center py-2 text-[10px] text-gray-400 bg-gray-50">
                        ნაჩვენებია 100 / {bankCount} ტრანზაქცია
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Invoices Preview */}
              {invoiceCount > 0 && (
                <div className="mt-8">
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
                    ინვოისები ({invoiceCount})
                  </h3>
                  <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                    <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                      <table className="w-full text-left">
                        <thead className="bg-gray-50 text-[10px] uppercase font-bold text-gray-400 sticky top-0">
                          <tr>
                            <th className="p-3">ინვოისი #</th>
                            <th className="p-3">თარიღი</th>
                            <th className="p-3">კლიენტი</th>
                            <th className="p-3 text-right">თანხა (USD)</th>
                          </tr>
                        </thead>
                        <tbody className="text-xs">
                          {invoices.map((inv, i) => (
                            <tr key={i} className="border-t border-gray-50 hover:bg-gray-50/50">
                              <td className="p-3 font-mono font-bold">{inv.invoiceNumber}</td>
                              <td className="p-3 text-gray-500">{inv.date}</td>
                              <td className="p-3">{inv.client}</td>
                              <td className="p-3 text-right font-mono font-bold">${fmt(inv.amountUSD)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ============================================================ */}
          {/* AUDIT VIEW                                                    */}
          {/* ============================================================ */}
          {view === 'audit' && (
            <motion.div
              key="audit"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {!hasResults ? (
                <div className="text-center py-20">
                  <Receipt size={48} className="mx-auto text-gray-200 mb-4" />
                  <p className="text-gray-400 text-sm">ჯერ არ გაშვებულა შეჯერება.</p>
                  <button onClick={() => setView('upload')} className="mt-4 text-blue-600 text-xs font-bold hover:underline">
                    გადადი ატვირთვაზე →
                  </button>
                </div>
              ) : (
                <>
                  {/* KPI Cards */}
                  {kpis && (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
                      {[
                        { label: 'სულ ინვოისი', value: `$${fmt(kpis.totalInvoiced)}`, color: 'text-gray-900' },
                        { label: 'გადახდილი', value: `$${fmt(kpis.totalPaid)}`, color: 'text-blue-600' },
                        { label: 'დარჩენილი', value: `$${fmt(kpis.outstanding)}`, color: 'text-red-600' },
                        { label: 'PAID', value: String(kpis.paidCount), color: 'text-emerald-600' },
                        { label: 'PARTIAL', value: String(kpis.partialCount), color: 'text-amber-600' },
                        { label: 'OPEN', value: String(kpis.openCount), color: 'text-red-600' },
                      ].map((kpi, i) => (
                        <div key={i} className="bg-white rounded-xl border border-gray-100 p-4">
                          <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">{kpi.label}</p>
                          <p className={`text-xl font-black ${kpi.color}`}>{kpi.value}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Toolbar */}
                  <div className="flex items-center justify-between mb-4 gap-4">
                    <input
                      type="text"
                      placeholder="ძებნა... (ინვოისი, კლიენტი, სტატუსი)"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="flex-1 max-w-md px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-xs outline-none focus:border-blue-400 transition-colors"
                    />
                    <button
                      onClick={exportReconciliation}
                      className="flex items-center gap-2 px-5 py-2.5 bg-black text-white rounded-xl text-xs font-bold hover:bg-blue-600 transition-all"
                    >
                      <Download size={14} /> ექსელში ჩამოტვირთვა
                    </button>
                  </div>

                  {/* Results Table */}
                  <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead className="bg-gray-50 text-[10px] uppercase font-bold text-gray-400">
                          <tr>
                            <th className="p-4">ინვოისი #</th>
                            <th className="p-4">თარიღი</th>
                            <th className="p-4">კლიენტი</th>
                            <th className="p-4 text-right">ინვოისი (USD)</th>
                            <th className="p-4 text-right">გადახდილი (USD)</th>
                            <th className="p-4 text-right">ნაშთი (USD)</th>
                            <th className="p-4 text-center">სტატუსი</th>
                            <th className="p-4">კომენტარი</th>
                            <th className="p-4"></th>
                          </tr>
                        </thead>
                        <tbody className="text-xs">
                          {filteredResults.map((r, i) => (
                            <tr
                              key={i}
                              className={`border-t hover:bg-gray-50/50 ${
                                r.status === 'OPEN' ? 'bg-red-50/30 border-red-100' :
                                r.status === 'PARTIAL' ? 'bg-amber-50/20 border-amber-100' :
                                'border-gray-50'
                              }`}
                            >
                              <td className="p-4 font-mono font-bold">
                                {r.isEditing ? <input className="w-full border rounded px-1" value={r.invoice.invoiceNumber} onChange={(e) => updateInvoice(i, 'invoiceNumber', e.target.value)} /> : r.invoice.invoiceNumber}
                              </td>
                              <td className="p-4 text-gray-500 whitespace-nowrap">
                                {r.isEditing ? <input className="w-full border rounded px-1" value={r.invoice.date} onChange={(e) => updateInvoice(i, 'date', e.target.value)} /> : r.invoice.date}
                              </td>
                              <td className="p-4 max-w-[180px] truncate" title={r.invoice.client}>
                                {r.isEditing ? <input className="w-full border rounded px-1" value={r.invoice.client} onChange={(e) => updateInvoice(i, 'client', e.target.value)} /> : r.invoice.client}
                              </td>
                              <td className="p-4 text-right font-mono">
                                {r.isEditing ? <input type="number" className="w-full border rounded px-1 text-right" value={r.invoice.amountUSD} onChange={(e) => updateInvoice(i, 'amountUSD', parseFloat(e.target.value))} /> : `$${fmt(r.invoice.amountUSD)}`}
                              </td>
                              <td className="p-4 text-right font-mono font-bold text-blue-600">${fmt(r.paidUSD)}</td>
                              <td className="p-4 text-right font-mono font-bold text-red-600">
                                {r.balanceUSD > 0 ? `$${fmt(r.balanceUSD)}` : '-'}
                              </td>
                              <td className="p-4 text-center">{statusBadge(r.status)}</td>
                              <td className="p-4 text-gray-500 italic text-[11px] max-w-[300px]" title={r.comment}>
                                {r.comment}
                              </td>
                              <td className="p-4">
                                <button onClick={() => toggleEdit(i)} className="text-blue-600 font-bold text-[10px] hover:underline">
                                  {r.isEditing ? 'შენახვა' : 'რედაქტირება'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="bg-gray-50 px-4 py-3 text-[10px] text-gray-400 flex justify-between">
                      <span>ნაჩვენებია {filteredResults.length} / {results.length} ინვოისი</span>
                      <span>ბოლო განახლება: {new Date().toLocaleString('ka-GE')}</span>
                    </div>
                  </div>
                </>
              )}
            </motion.div>
          )}

          {/* ============================================================ */}
          {/* DEBTORS VIEW                                                  */}
          {/* ============================================================ */}
          {view === 'debtors' && (
            <motion.div
              key="debtors"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {!hasResults ? (
                <div className="text-center py-20">
                  <Users size={48} className="mx-auto text-gray-200 mb-4" />
                  <p className="text-gray-400 text-sm">ჯერ არ გაშვებულა შეჯერება.</p>
                  <button onClick={() => setView('upload')} className="mt-4 text-blue-600 text-xs font-bold hover:underline">
                    გადადი ატვირთვაზე →
                  </button>
                </div>
              ) : (
                <>
                  {/* Toolbar */}
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                    <div>
                      <h2 className="text-2xl font-black">დებიტორული დავალიანება</h2>
                      <p className="text-gray-400 text-xs mt-1">
                        სულ: <span className="text-red-600 font-bold">${fmt(debtors.reduce((s, d) => s + d.balance, 0))}</span>
                        {' '}({debtors.length} კლიენტი)
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2">
                        <span className="text-[10px] text-gray-400 font-bold">თარიღი:</span>
                        <input
                          type="date"
                          value={asOfDate}
                          onChange={(e) => setAsOfDate(e.target.value)}
                          className="text-xs font-medium outline-none bg-transparent"
                        />
                      </div>
                      <button
                        onClick={exportDebtors}
                        disabled={debtors.length === 0}
                        className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded-xl text-xs font-bold hover:bg-blue-600 transition-all disabled:opacity-30"
                      >
                        <Download size={14} /> Export
                      </button>
                    </div>
                  </div>

                  {/* Debtors Grid */}
                  {debtors.length === 0 ? (
                    <div className="text-center py-16 text-gray-400 text-sm">
                      ამ თარიღისთვის დებიტორული დავალიანება არ მოიძებნა.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {debtors.map((d, i) => (
                        <div key={i} className="bg-white rounded-2xl border border-gray-100 p-6 hover:border-red-200 transition-colors">
                          <div className="flex items-start justify-between mb-3">
                            <h4 className="text-sm font-bold leading-tight max-w-[200px]">{d.name}</h4>
                            <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-bold">
                              {d.invoiceCount} ინვ.
                            </span>
                          </div>
                          <p className="text-3xl font-black text-red-600 mb-3">${fmt(d.balance)}</p>
                          <div className="grid grid-cols-2 gap-2 text-[10px]">
                            <div>
                              <p className="text-gray-400">ინვოისი</p>
                              <p className="font-bold">${fmt(d.totalInvoiced)}</p>
                            </div>
                            <div>
                              <p className="text-gray-400">გადახდილი</p>
                              <p className="font-bold text-blue-600">${fmt(d.totalPaid)}</p>
                            </div>
                            <div className="col-span-2">
                              <p className="text-gray-400">უძველესი: {d.oldestDate}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </motion.div>
          )}
          {/* ============================================================ */}
          {/* BILLS VIEW                                                    */}
          {/* ============================================================ */}
          {view === 'bills' && (
            <motion.div
              key="bills"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              <div className="flex items-center justify-between mb-4 gap-4">
                <h2 className="text-2xl font-black">ა/ფატურა</h2>
                <div className="flex items-center gap-2">
                  <input className="w-10 border rounded px-1 text-xs" placeholder="MM" value={batchMonth} onChange={(e) => setBatchMonth(e.target.value)} />
                  <input className="w-12 border rounded px-1 text-xs" placeholder="YYYY" value={batchYear} onChange={(e) => setBatchYear(e.target.value)} />
                  <button onClick={batchUpdateBills} className="px-3 py-1 bg-black text-white rounded text-xs font-bold">განახლება</button>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={updateBillsFromTransactions}
                    className="flex items-center gap-2 px-5 py-2.5 bg-gray-100 text-black rounded-xl text-xs font-bold hover:bg-gray-200 transition-all"
                  >
                    <Clock size={14} /> განახლება
                  </button>
                  <button
                    onClick={exportBillsToXLSX}
                    className="flex items-center gap-2 px-5 py-2.5 bg-black text-white rounded-xl text-xs font-bold hover:bg-blue-600 transition-all"
                  >
                    <Download size={14} /> ექსელში ჩამოტვირთვა
                  </button>
                </div>
              </div>
              <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50 text-[10px] uppercase font-bold text-gray-400">
                      <tr>
                        <th className="p-4"><input type="checkbox" onChange={toggleSelectAll} checked={bills.length > 0 && bills.every(b => b.isSelected)} /></th>
                        <th className="p-4">თვე/წელი</th>
                        <th className="p-4">Tax ID</th>
                        <th className="p-4">Vendor</th>
                        <th className="p-4">Desc</th>
                        <th className="p-4">Dates</th>
                        <th className="p-4">Invoice #</th>
                        <th className="p-4">Date</th>
                        <th className="p-4">Amount GEL</th>
                        <th className="p-4">Transfer Date</th>
                        <th className="p-4">FXR</th>
                        <th className="p-4"></th>
                      </tr>
                    </thead>
                    <tbody className="text-xs">
                      {bills.map((b, i) => (
                        <tr key={b.id} className="border-t border-gray-50 hover:bg-gray-50/50">
                          <td className="p-4"><input type="checkbox" checked={b.isSelected || false} onChange={() => toggleSelectBill(i)} /></td>
                          <td className="p-4">
                            {b.isEditing ? <div className="flex gap-1"><input className="w-10 border rounded px-1" value={b.serviceMonth} onChange={(e) => updateBill(i, 'serviceMonth', e.target.value)} />/<input className="w-12 border rounded px-1" value={b.serviceYear} onChange={(e) => updateBill(i, 'serviceYear', e.target.value)} /></div> : `${b.serviceMonth}/${b.serviceYear}`}
                          </td>
                          <td className="p-4">{b.isEditing ? <input className="w-20 border rounded px-1" value={b.taxID} onChange={(e) => updateBill(i, 'taxID', e.target.value)} /> : b.taxID}</td>
                          <td className="p-4">{b.isEditing ? <input className="w-24 border rounded px-1" value={b.vendorName} onChange={(e) => updateBill(i, 'vendorName', e.target.value)} /> : b.vendorName}</td>
                          <td className="p-4">{b.isEditing ? <input className="w-24 border rounded px-1" value={b.description} onChange={(e) => updateBill(i, 'description', e.target.value)} /> : b.description}</td>
                          <td className="p-4">{b.isEditing ? <input className="w-24 border rounded px-1" value={b.stayDates} onChange={(e) => updateBill(i, 'stayDates', e.target.value)} /> : b.stayDates}</td>
                          <td className="p-4">{b.isEditing ? <input className="w-20 border rounded px-1" value={b.invoiceNumber} onChange={(e) => updateBill(i, 'invoiceNumber', e.target.value)} /> : b.invoiceNumber}</td>
                          <td className="p-4">{b.isEditing ? <input className="w-20 border rounded px-1" value={b.invoiceDate} onChange={(e) => updateBill(i, 'invoiceDate', e.target.value)} /> : b.invoiceDate}</td>
                          <td className="p-4">{b.isEditing ? <input type="number" className="w-20 border rounded px-1" value={b.amountGEL} onChange={(e) => updateBill(i, 'amountGEL', parseFloat(e.target.value))} /> : fmt(b.amountGEL)}</td>
                          <td className="p-4">{b.isEditing ? <input className="w-20 border rounded px-1" value={b.transferDate || ''} onChange={(e) => updateBill(i, 'transferDate', e.target.value)} /> : b.transferDate || '-'}</td>
                          <td className="p-4">{b.isEditing ? <input type="number" className="w-16 border rounded px-1" value={b.fxr || ''} onChange={(e) => updateBill(i, 'fxr', parseFloat(e.target.value))} /> : b.fxr || '-'}</td>
                          <td className="p-4 flex gap-2">
                            <button onClick={() => toggleEditBill(i)} className="text-blue-600 font-bold hover:underline">{b.isEditing ? 'შენახვა' : 'ედით'}</button>
                            <button onClick={() => deleteBill(i)} className="text-red-600 font-bold hover:underline">წაშლა</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}