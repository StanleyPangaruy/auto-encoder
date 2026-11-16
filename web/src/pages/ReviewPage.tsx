import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Kbd, Paper, ScrollArea, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput, Textarea, Title, UnstyledButton } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { api, review, MANUAL, MONTHS, PARTICULARS, peso, type Kind, type ReviewRow } from "../api";
import { ScanViewer } from "./ScanViewer";

const needsChecking = (r: ReviewRow) => r.remarks?.startsWith(MANUAL);
const reasons = (r: ReviewRow) => (r.remarks ?? "").replace(`${MANUAL}: `, "").split("; ").filter(Boolean);

export function ReviewPage() {
  const [params, setParams] = useSearchParams();
  const clientId = params.get("client");
  const file = params.get("file");
  const sheet = params.get("sheet");
  const [show, setShow] = useState("check");
  const [selected, setSelected] = useState<number | null>(null);
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };

  const clients = useQuery({ queryKey: ["clients"], queryFn: api.clients });
  const workbooks = useQuery({ queryKey: ["workbooks", clientId], queryFn: () => review.workbooks(clientId!), enabled: Boolean(clientId) });
  const workbook = workbooks.data?.find((w) => w.file === file);
  const rows = useQuery({ queryKey: ["review-rows", file, sheet], queryFn: () => review.rows(file!, sheet!), enabled: Boolean(file && sheet) });

  // Fill in sensible choices: first client, its workbook with the most to check, that workbook's first sheet with something to check.
  useEffect(() => {
    if (!clientId && clients.data?.length) set({ client: clients.data[0].id });
  }, [clients.data, clientId]);
  useEffect(() => {
    if (clientId && workbooks.data && !workbook) {
      const pick = [...workbooks.data].sort((a, b) => b.toCheck - a.toCheck)[0];
      if (pick) set({ file: pick.file, sheet: (pick.sheets.find((s) => s.toCheck) ?? pick.sheets[0])?.name ?? null });
    }
  }, [workbooks.data, clientId, workbook]);

  const list = useMemo(() => (rows.data?.rows ?? []).filter((r) => show === "all" || needsChecking(r)), [rows.data, show]);
  const current = rows.data?.rows.find((r) => r.id === selected) ?? null;
  const numberOf = (r: ReviewRow) => (rows.data?.rows.indexOf(r) ?? 0) + 1;
  const sheetInfo = rows.data?.sheets.find((s) => s.name === sheet);
  const totalInSheet = rows.data?.rows.length ?? 0;

  // Keep a row selected: the first in the list when nothing (or something no longer listed) is selected.
  useEffect(() => {
    if (!list.length) return setSelected(null);
    if (!list.some((r) => r.id === selected)) setSelected(list[0].id);
  }, [list]);

  const goNext = (afterId: number) => {
    const all = rows.data?.rows ?? [];
    const at = all.findIndex((r) => r.id === afterId);
    const next = [...all.slice(at + 1), ...all.slice(0, at)].find((r) => show === "all" || needsChecking(r));
    setSelected(next?.id ?? null);
  };

  return (
    <Stack h="calc(100vh - 56px - 2 * var(--mantine-spacing-lg))" gap="sm">
      <Group justify="space-between" align="flex-end" wrap="nowrap">
        <Group align="flex-end" gap="sm" wrap="nowrap">
          <Title order={2} mr="sm">
            Review
          </Title>
          <Select
            label="Client"
            w={230}
            data={(clients.data ?? []).map((c) => ({ value: c.id, label: c.buyerName }))}
            value={clientId}
            onChange={(v) => set({ client: v, file: null, sheet: null })}
            allowDeselect={false}
          />
          <Select
            label="Workbook"
            w={260}
            data={(workbooks.data ?? []).map((w) => ({ value: w.file, label: `${w.name}${w.toCheck ? ` (${w.toCheck} to check)` : ""}` }))}
            value={file}
            onChange={(v) => {
              const w = workbooks.data?.find((x) => x.file === v);
              set({ file: v, sheet: (w?.sheets.find((s) => s.toCheck) ?? w?.sheets[0])?.name ?? null });
            }}
            allowDeselect={false}
          />
          <Select
            label="Sheet"
            w={170}
            data={(rows.data?.sheets ?? workbook?.sheets ?? []).map((s) => ({ value: s.name, label: `${s.name}${s.toCheck ? ` (${s.toCheck})` : ""}` }))}
            value={sheet}
            onChange={(v) => set({ sheet: v })}
            allowDeselect={false}
          />
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" c="dimmed">
            {sheetInfo ? `${sheetInfo.toCheck} of ${sheetInfo.rows} left to check` : ""}
          </Text>
          <SegmentedControl
            size="xs"
            value={show}
            onChange={setShow}
            data={[
              { value: "check", label: "To check" },
              { value: "all", label: "All rows" },
            ]}
          />
        </Group>
      </Group>

      <div style={{ display: "grid", gridTemplateColumns: "230px minmax(0, 1fr) 370px", gap: "var(--mantine-spacing-sm)", flex: 1, minHeight: 0 }}>
        <Paper withBorder style={{ minHeight: 0, display: "flex", flexDirection: "column" }}>
          <ScrollArea style={{ flex: 1 }}>
            {list.map((r) => (
              <UnstyledButton
                key={r.id}
                onClick={() => setSelected(r.id)}
                w="100%"
                px="sm"
                py={6}
                bg={r.id === selected ? "teal.0" : undefined}
                style={{ borderBottom: "1px solid var(--mantine-color-gray-2)", borderLeft: `3px solid ${needsChecking(r) ? "var(--mantine-color-orange-5)" : "transparent"}` }}
              >
                <Group justify="space-between" wrap="nowrap" gap={4}>
                  <Text size="xs" c="dimmed">
                    {numberOf(r)}
                    {r.month ? ` · ${r.month}${r.day ? " " + r.day : ""}` : ""}
                  </Text>
                  <Text size="xs" fw={500}>
                    {peso(r.amount ?? null) || "—"}
                  </Text>
                </Group>
                <Text size="sm" truncate>
                  {r.company || <i>no company</i>}
                </Text>
              </UnstyledButton>
            ))}
            {rows.data && list.length === 0 && (
              <Text size="sm" c="dimmed" p="md">
                {show === "check" ? "Nothing left to check on this sheet." : "This sheet is empty."}
              </Text>
            )}
          </ScrollArea>
        </Paper>

        <Paper withBorder p={6} style={{ minHeight: 0 }}>
          {current && file ? <ScanViewer rowId={current.id} workbook={file} /> : <Text c="dimmed" p="md">Choose a row.</Text>}
        </Paper>

        <Paper withBorder p="sm" style={{ minHeight: 0, overflow: "auto" }}>
          {current && rows.data && (
            <RowForm
              key={current.id}
              row={current}
              kind={rows.data.kind}
              position={`row ${numberOf(current)} of ${totalInSheet}`}
              onSaved={(saved, checked) => {
                if (checked) goNext(saved.id);
              }}
            />
          )}
        </Paper>
      </div>
    </Stack>
  );
}

type Draft = Record<string, string>;

const PURCHASE_FIELDS = ["month", "day", "number", "tin", "company", "last", "first", "middle", "address", "city", "particulars", "amount", "vat", "net", "inputVat", "nonVat", "remarks"];
const CERTIFICATE_FIELDS = ["month", "tin", "company", "last", "first", "middle", "address", "city", "amount", "atc", "rate", "wtax", "remarks"];

/** The row as text fields; RATE is shown as a percentage. */
function toDraft(row: ReviewRow, kind: Kind): Draft {
  const out: Draft = {};
  for (const key of kind === "2307" ? CERTIFICATE_FIELDS : PURCHASE_FIELDS) {
    const v = (row as unknown as Record<string, unknown>)[key];
    out[key] = v == null ? "" : key === "rate" ? String(Math.round(Number(v) * 10000) / 100) : String(v);
  }
  if (kind === "purchases" && !out.vat) out.vat = "auto";
  return out;
}

function fromDraft(draft: Draft, kind: Kind) {
  const out: Record<string, string | number | null> = { ...draft };
  if (kind === "2307") out.rate = draft.rate === "" ? null : Number(draft.rate) / 100;
  return out;
}

function RowForm({ row, kind, position, onSaved }: { row: ReviewRow; kind: Kind; position: string; onSaved: (row: ReviewRow, checked: boolean) => void }) {
  const queryClient = useQueryClient();
  const original = useRef(toDraft(row, kind));
  const [draft, setDraft] = useState<Draft>(original.current);
  const changed = Object.keys(draft).some((k) => draft[k] !== original.current[k]);
  const f = (key: string) => ({
    value: draft[key] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [key]: e.currentTarget.value })),
  });

  const save = useMutation({
    mutationFn: ({ checked }: { checked: boolean }) => {
      const changes = fromDraft(draft, kind);
      return review.save(row.id, checked ? { ...changes, checked: true } : (changes as Partial<ReviewRow>));
    },
    onSuccess: (saved, { checked }) => {
      queryClient.invalidateQueries({ queryKey: ["review-rows"] });
      queryClient.invalidateQueries({ queryKey: ["workbooks"] });
      notifications.show({ color: "teal", message: checked ? "Saved and marked checked" : "Saved", autoClose: 1500 });
      onSaved(saved, checked);
    },
    onError: (err: Error) => {
      queryClient.invalidateQueries({ queryKey: ["review-rows"] });
      notifications.show({ color: "red", title: "Not saved", message: err.message, autoClose: 8000 });
    },
  });

  useHotkeys(
    [
      ["mod+S", () => save.mutate({ checked: false })],
      ["mod+Enter", () => save.mutate({ checked: true })],
    ],
    [],
  );

  const flagged = needsChecking(row);
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="sm" fw={600}>
          {position}
        </Text>
        {flagged ? <Badge color="orange">to check</Badge> : row.checked ? <Badge color="teal">checked</Badge> : null}
      </Group>
      {flagged && (
        <Alert color="orange" p="xs">
          <Stack gap={2}>
            {reasons(row).map((r, i) => (
              <Text key={i} size="xs">
                • {r}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <SimpleGrid cols={kind === "2307" ? 2 : 3} spacing="xs">
        <Select label="Month" data={["", ...MONTHS].map((m) => ({ value: m, label: m || "—" }))} value={draft.month} onChange={(v) => setDraft((d) => ({ ...d, month: v ?? "" }))} allowDeselect={false} />
        {kind === "purchases" && <TextInput label="Day" {...f("day")} />}
        {kind === "purchases" ? <TextInput label="SI/OR" {...f("number")} /> : <TextInput label="TIN" {...f("tin")} />}
      </SimpleGrid>
      {kind === "purchases" && <TextInput label="TIN" {...f("tin")} />}
      <TextInput label="Company" {...f("company")} />
      <SimpleGrid cols={3} spacing="xs">
        <TextInput label="Last" {...f("last")} />
        <TextInput label="First" {...f("first")} />
        <TextInput label="Middle" {...f("middle")} />
      </SimpleGrid>
      <TextInput label="Address" {...f("address")} />
      <TextInput label="City" {...f("city")} />

      {kind === "purchases" ? (
        <>
          <Select label="Particulars" data={["", ...PARTICULARS].map((p) => ({ value: p, label: p || "—" }))} value={draft.particulars} onChange={(v) => setDraft((d) => ({ ...d, particulars: v ?? "" }))} allowDeselect={false} />
          <TextInput label="Amount" {...f("amount")} />
          <SegmentedControl
            size="xs"
            value={draft.vat}
            onChange={(v) => setDraft((d) => ({ ...d, vat: v }))}
            data={[
              { value: "auto", label: "12% VAT (automatic)" },
              { value: "manual", label: "Enter VAT by hand" },
            ]}
          />
          {draft.vat === "manual" ? (
            <SimpleGrid cols={3} spacing="xs">
              <TextInput label="Net of VAT" {...f("net")} />
              <TextInput label="Input VAT" {...f("inputVat")} />
              <TextInput label="Non VAT" {...f("nonVat")} />
            </SimpleGrid>
          ) : (
            <TextInput label="Non VAT" description="Usually empty for a VAT invoice" {...f("nonVat")} />
          )}
        </>
      ) : (
        <SimpleGrid cols={3} spacing="xs">
          <TextInput label="Amount" {...f("amount")} />
          <TextInput label="ATC" {...f("atc")} />
          <TextInput label="Rate %" {...f("rate")} />
          <TextInput label="WTAX" {...f("wtax")} />
        </SimpleGrid>
      )}
      <Textarea label="Remarks" autosize minRows={2} maxRows={5} {...f("remarks")} />

      <Group grow gap="xs" mt={4}>
        <Button variant="default" disabled={!changed} loading={save.isPending && !save.variables?.checked} onClick={() => save.mutate({ checked: false })}>
          Save
        </Button>
        <Button loading={save.isPending && save.variables?.checked} onClick={() => save.mutate({ checked: true })}>
          {flagged ? "Checked, next" : "Save, next"}
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        <Kbd>Ctrl</Kbd> + <Kbd>S</Kbd> saves · <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> saves, clears the checking remark and moves on. Each save updates the
        workbook; close it in Excel first.
      </Text>
    </Stack>
  );
}
