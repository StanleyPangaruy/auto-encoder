// The app server's API, as the screens use it.

export type Layout = "month" | "file-order";
export type AddressStyle = "district" | "full";
export type Kind = "purchases" | "2307";

export interface Client {
  id: string;
  buyerName: string;
  buyerTin: string;
  model: string;
  layout: Layout;
  addressStyle: AddressStyle;
  inventoryHint: string;
  folder: string;
  rawDir: string;
  outputDir: string;
}

export type ClientInput = Pick<Client, "buyerName" | "buyerTin" | "model" | "layout" | "addressStyle" | "inventoryHint"> & { folder?: string };

export interface Source {
  name: string;
  path: string;
  type: "folder" | "pdf";
  files: number;
  size: number | null;
}

export interface AddedRow {
  source: string;
  page: number | null;
  month: string;
  number: string;
  company: string;
  amount: number | null;
  remarks: string;
}

export interface Note {
  file: string;
  reason: string;
}

export interface JobSummary {
  phase?: "first" | "second";
  files?: number;
  pages?: number;
  encoded?: number;
  manualChecking?: number;
  duplicates?: Note[];
  skipped?: Note[];
  failed?: Note[];
  workbooks?: string[];
  added?: AddedRow[];
  reread?: number;
  doubtful?: number;
  cost?: number;
  clientTin?: string;
  secondPassOffer?: { count: number; unit: "file" | "page"; model: string; estimate: number } | null;
  firstPass?: { encoded?: number; manualChecking?: number; cost?: number };
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: number;
  clientId: string;
  kind: Kind;
  source: string;
  status: JobStatus;
  error: string | null;
  options: { byPage?: boolean; sheet?: string; model?: string };
  summary: JobSummary;
  createdAt: string;
  finishedAt: string | null;
}

export interface Progress {
  type: "status" | "progress";
  status?: JobStatus;
  phase?: string;
  done?: number;
  total?: number;
  item?: string;
  cost?: number;
  error?: string;
  summary?: JobSummary;
}

export interface KeyStatus {
  set: boolean;
  ending: string | null;
}

export interface CostRow {
  client_id: string;
  month: string;
  cost: number;
  calls: number;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined || body instanceof FormData ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `The app server answered ${response.status}`);
  return data as T;
}

export const api = {
  status: () => request<{ apiKey: boolean; secondModel: string; costThisMonth: number }>("GET", "/api/status"),
  clients: () => request<Client[]>("GET", "/api/clients"),
  createClient: (input: ClientInput) => request<Client>("POST", "/api/clients", input),
  updateClient: (id: string, input: Partial<ClientInput>) => request<Client>("PUT", `/api/clients/${id}`, input),
  sources: (id: string) => request<Source[]>("GET", `/api/clients/${id}/sources`),
  upload: (form: FormData) => request<{ source: string; files: number }>("POST", "/api/uploads", form),
  jobs: (clientId?: string) => request<Job[]>("GET", clientId ? `/api/jobs?client=${encodeURIComponent(clientId)}` : "/api/jobs"),
  job: (id: number) => request<Job>("GET", `/api/jobs/${id}`),
  startJob: (input: { clientId: string; kind: Kind; source: string; byPage?: boolean; sheet?: string }) => request<Job>("POST", "/api/jobs", input),
  secondPass: (id: number) => request<Job>("POST", `/api/jobs/${id}/second-pass`),
  open: (path: string) => request<{ opened: boolean }>("POST", "/api/open", { path }),
  settings: () => request<{ apiKey: KeyStatus }>("GET", "/api/settings"),
  testKey: () => request<{ ok: boolean; reason?: string }>("POST", "/api/settings/api-key/test"),
  saveKey: (key: string) => request<{ apiKey: KeyStatus }>("PUT", "/api/settings/api-key", { key }),
  costs: () => request<CostRow[]>("GET", "/api/costs"),
  quit: (force = false) => request<{ stopping: boolean }>("POST", "/api/quit", { force }),
};

export const MODELS = [
  { value: "claude-haiku-5-5", label: "Haiku: cheapest, fine for printed documents" },
  { value: "claude-sonnet-5-5", label: "Sonnet: best for handwriting, costs more" },
];

export const modelName = (model: string) => (model.includes("haiku") ? "Haiku" : model.includes("sonnet") ? "Sonnet" : model.includes("opus") ? "Opus" : model);

export const peso = (n: number | null | undefined) =>
  n == null ? "" : n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const dollars = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;

export const fileName = (path: string) => path.split("/").pop() ?? path;

// ---- review

export interface SheetInfo {
  name: string;
  rows: number;
  toCheck: number;
}

export interface Workbook {
  file: string;
  clientId: string;
  kind: Kind;
  name: string;
  sheets: SheetInfo[];
  toCheck: number;
  rows: number;
}

/** A workbook row as the review screen edits it. Purchases and 2307 rows share most fields. */
export interface ReviewRow {
  id: number;
  sheet: string;
  page: number | null;
  source?: string;
  remarks: string;
  checked: boolean;
  month?: string;
  day?: string;
  number?: string;
  tin?: string;
  company?: string;
  last?: string;
  first?: string;
  middle?: string;
  address?: string;
  city?: string;
  nature?: string;
  particulars?: string;
  amount?: number | null;
  vat?: "auto" | "manual";
  net?: number | null;
  inputVat?: number | null;
  nonVat?: number | null;
  atc?: string;
  rate?: number | null;
  wtax?: number | null;
}

export interface ScanInfo {
  found: boolean;
  kind?: Kind;
  file?: string;
  page?: number;
  url?: string;
  choices?: string[];
}

export const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const PARTICULARS = ["INVENTORY", "OFFICE SUPPLIES", "FUEL AND OIL", "UTILITIES EXPENSE", "REPRESENTATION EXPENSE"];
export const MANUAL = "FOR MANUAL CHECKING";

export const review = {
  workbooks: (clientId: string) => request<Workbook[]>("GET", `/api/workbooks?client=${encodeURIComponent(clientId)}`),
  rows: (file: string, sheet: string) =>
    request<{ file: string; kind: Kind; sheets: SheetInfo[]; rows: ReviewRow[] }>("GET", `/api/workbooks/rows?file=${encodeURIComponent(file)}&sheet=${encodeURIComponent(sheet)}`),
  save: (id: number, changes: Partial<ReviewRow> & { checked?: boolean }) => request<ReviewRow>("PUT", `/api/rows/${id}`, changes),
  scanInfo: (id: number) => request<ScanInfo>("GET", `/api/rows/${id}/scan-info`),
  setPdf: (file: string, pdf: string) => request<{ ok: boolean }>("PUT", "/api/workbooks/pdf", { file, pdf }),
};
