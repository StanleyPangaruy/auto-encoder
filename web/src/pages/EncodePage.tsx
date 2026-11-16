import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Group, Paper, Radio, ScrollArea, SegmentedControl, Select, Stack, Tabs, Text, TextInput, Title } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, modelName, type Kind } from "../api";

const thisMonth = () => new Date().toISOString().slice(0, 7);
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function EncodePage() {
  const navigate = useNavigate();
  const clients = useQuery({ queryKey: ["clients"], queryFn: api.clients });
  const [clientId, setClientId] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("purchases");
  const [mode, setMode] = useState<string | null>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [batch, setBatch] = useState(thisMonth());
  const [existing, setExisting] = useState<string | null>(null);
  const [byPage, setByPage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const client = clients.data?.find((c) => c.id === clientId);
  const sources = useQuery({ queryKey: ["sources", clientId], queryFn: () => api.sources(clientId!), enabled: Boolean(clientId) });
  const choices = useMemo(
    () => (sources.data ?? []).filter((s) => (kind === "2307" ? s.type === "pdf" : true)),
    [sources.data, kind],
  );

  // Start from the first client, and forget choices that no longer fit when the client or kind changes.
  useEffect(() => {
    if (!clientId && clients.data?.length) setClientId(clients.data[0].id);
  }, [clients.data, clientId]);
  useEffect(() => {
    setExisting(null);
    setFiles([]);
  }, [clientId, kind]);

  const ready = Boolean(client) && (mode === "upload" ? files.length > 0 && (kind === "2307" || batch.trim()) : Boolean(existing));

  async function start() {
    if (!client) return;
    try {
      let source = existing ?? "";
      if (mode === "upload") {
        setBusy(`Sending ${files.length} file${files.length === 1 ? "" : "s"} to the app...`);
        const form = new FormData();
        // The server reads these fields before the files, so they go first.
        form.append("clientId", client.id);
        form.append("kind", kind);
        form.append("batch", batch.trim());
        for (const f of files) form.append("files", f, f.name);
        source = (await api.upload(form)).source;
      }
      setBusy("Starting...");
      const job = await api.startJob({ clientId: client.id, kind, source, byPage: kind === "purchases" && byPage });
      navigate(`/jobs/${job.id}`);
    } catch (err) {
      notifications.show({ color: "red", title: "Could not start", message: (err as Error).message });
      setBusy(null);
    }
  }

  return (
    <Stack maw={820}>
      <div>
        <Title order={2}>Encode</Title>
        <Text c="dimmed" size="sm">
          Choose the client and what kind of documents these are, then add the scans.
        </Text>
      </div>

      <Paper withBorder p="lg">
        <Stack>
          <Group grow align="flex-end">
            <Select
              label="Client"
              data={(clients.data ?? []).map((c) => ({ value: c.id, label: c.buyerName }))}
              value={clientId}
              onChange={setClientId}
              allowDeselect={false}
              searchable
            />
            <div>
              <Text size="sm" fw={500} mb={4}>
                Documents
              </Text>
              <SegmentedControl
                fullWidth
                value={kind}
                onChange={(v) => setKind(v as Kind)}
                data={[
                  { value: "purchases", label: "Purchases" },
                  { value: "2307", label: "BIR 2307" },
                ]}
              />
            </div>
          </Group>
          {client && (
            <Text size="sm" c="dimmed">
              Read with <b>{modelName(client.model)}</b>. If some documents can't be read cleanly, you'll be asked before anything is re-read with
              Sonnet.
            </Text>
          )}
        </Stack>
      </Paper>

      <Paper withBorder p="lg">
        <Tabs value={mode} onChange={setMode}>
          <Tabs.List mb="md">
            <Tabs.Tab value="upload">Add new scans</Tabs.Tab>
            <Tabs.Tab value="existing">Already in {client ? client.rawDir : "the client's folder"}</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="upload">
            <Stack>
              {kind === "purchases" && (
                <TextInput
                  label="Batch name"
                  description={
                    client?.layout === "file-order"
                      ? "Becomes the sheet name in this client's workbook, for example Sept 2026"
                      : "A folder name for these scans, usually the month, for example 2026-11"
                  }
                  value={batch}
                  onChange={(e) => setBatch(e.currentTarget.value)}
                />
              )}
              <Dropzone
                onDrop={(dropped) => setFiles(kind === "2307" ? dropped.slice(0, 1) : (prev) => [...prev, ...dropped])}
                multiple={kind === "purchases"}
                accept={kind === "2307" ? ["application/pdf"] : undefined}
                maxSize={600 * 1024 * 1024}
              >
                <Stack align="center" gap={4} py="lg">
                  <Text fw={600}>{kind === "2307" ? "Drop the PDF of 2307 certificates here" : "Drop scans here: photos, images or PDFs"}</Text>
                  <Text size="sm" c="dimmed">
                    or click to choose files
                  </Text>
                </Stack>
              </Dropzone>
              {files.length > 0 && (
                <Stack gap={4}>
                  <Group justify="space-between">
                    <Text size="sm" fw={500}>
                      {files.length} file{files.length === 1 ? "" : "s"}, {megabytes(files.reduce((s, f) => s + f.size, 0))}
                    </Text>
                    <Button size="xs" variant="subtle" color="gray" onClick={() => setFiles([])}>
                      Clear
                    </Button>
                  </Group>
                  <ScrollArea.Autosize mah={160}>
                    {files.map((f) => (
                      <Text key={f.name + f.size} size="xs" c="dimmed">
                        {f.name}
                      </Text>
                    ))}
                  </ScrollArea.Autosize>
                </Stack>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="existing">
            {choices.length === 0 ? (
              <Text c="dimmed" size="sm">
                Nothing here yet for {kind === "2307" ? "2307 (no PDFs)" : "this client"}.
              </Text>
            ) : (
              <Radio.Group value={existing} onChange={setExisting}>
                <ScrollArea.Autosize mah={300}>
                  <Stack gap={8}>
                    {choices.map((s) => (
                      <Radio
                        key={s.path}
                        value={s.path}
                        label={s.name}
                        description={s.type === "folder" ? `folder, ${s.files} file${s.files === 1 ? "" : "s"}` : `PDF, ${megabytes(s.size ?? 0)}`}
                      />
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              </Radio.Group>
            )}
          </Tabs.Panel>
        </Tabs>
      </Paper>

      {kind === "purchases" && (
        <Checkbox
          label="Read PDFs page by page"
          description="For bundles of small till receipts scanned two to a page. Leave off for invoices that run over several pages."
          checked={byPage}
          onChange={(e) => setByPage(e.currentTarget.checked)}
        />
      )}

      {kind === "purchases" && client?.layout === "file-order" && mode === "existing" && existing && (
        <Alert color="gray" variant="light">
          The sheet will be named after this folder or file.
        </Alert>
      )}

      <Group>
        <Button size="md" disabled={!ready} loading={Boolean(busy)} onClick={start}>
          Encode
        </Button>
        {busy && (
          <Text size="sm" c="dimmed">
            {busy}
          </Text>
        )}
      </Group>
    </Stack>
  );
}
