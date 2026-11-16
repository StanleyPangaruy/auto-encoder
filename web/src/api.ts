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
  status: () => request<{ apiKey: boolean; secondModel: string }>("GET", "/api/status"),
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
