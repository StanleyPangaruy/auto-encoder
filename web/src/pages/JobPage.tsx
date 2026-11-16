import { useEffect, useState } from "react";
import { Accordion, Alert, Badge, Button, Card, Group, Loader, Progress as Bar, SegmentedControl, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api, dollars, fileName, peso, type Job, type Note, type Progress } from "../api";

const STATUS_COLOR = { queued: "gray", running: "blue", done: "teal", failed: "red" } as const;
const STATUS_LABEL = { queued: "Waiting to start", running: "Reading", done: "Finished", failed: "Failed" } as const;

/** Follows a running job's progress through the server's event stream. */
function useJobProgress(jobId: number, onFinished: () => void) {
  const [progress, setProgress] = useState<Progress | null>(null);
  useEffect(() => {
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onmessage = (e) => {
      const event: Progress = JSON.parse(e.data);
      setProgress((prev) => (event.type === "progress" ? event : { ...prev, ...event }));
      if (event.type === "status" && (event.status === "done" || event.status === "failed")) onFinished();
    };
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  return progress;
}

export function JobPage() {
  const id = Number(useParams().id);
  const queryClient = useQueryClient();
  const job = useQuery({ queryKey: ["job", id], queryFn: () => api.job(id) });
  const clients = useQuery({ queryKey: ["clients"], queryFn: api.clients });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["job", id] });
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };
  const progress = useJobProgress(id, refresh);

  const secondPass = useMutation({
    mutationFn: () => api.secondPass(id),
    onSuccess: refresh,
    onError: (err: Error) => notifications.show({ color: "red", message: err.message }),
  });

  if (job.isLoading) return <Loader />;
  if (!job.data) return <Alert color="red">This job could not be found.</Alert>;
  const j = job.data;
  const client = clients.data?.find((c) => c.id === j.clientId);
  const status = progress?.status ?? j.status;
  const active = status === "queued" || status === "running";

  return (
    <Stack maw={1100}>
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>
            {j.kind === "2307" ? "BIR 2307" : "Purchases"}: {fileName(j.source)}
          </Title>
          <Text c="dimmed" size="sm">
            {client?.buyerName ?? j.clientId} · job {j.id} · started {new Date(j.createdAt + "Z").toLocaleString()}
          </Text>
        </div>
        <Badge size="lg" color={STATUS_COLOR[status]} variant="light">
          {STATUS_LABEL[status]}
        </Badge>
      </Group>

      {active && <Running progress={progress} />}
      {status === "failed" && (
        <Alert color="red" title="The job stopped">
          {progress?.error ?? j.error}
        </Alert>
      )}
      {status === "done" && <Results job={j} onSecondPass={() => secondPass.mutate()} starting={secondPass.isPending} />}
    </Stack>
  );
}

function Running({ progress }: { progress: Progress | null }) {
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const second = progress?.phase === "second";
  return (
    <Card withBorder p="lg">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>{second ? "Second reading with Sonnet" : "Reading the documents"}</Text>
          <Text size="sm" c="dimmed">
            {total ? `${done} of ${total}` : "starting..."}
          </Text>
        </Group>
        <Bar value={total ? (done / total) * 100 : 0} animated striped size="lg" />
        <Group justify="space-between">
          <Text size="sm" c="dimmed" truncate maw="70%">
            {progress?.item ?? ""}
          </Text>
          <Text size="sm" c="dimmed">
            cost so far {dollars(progress?.cost)}
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          You can leave this page; the job keeps running. Documents read before are not paid for again.
        </Text>
      </Stack>
    </Card>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <Card withBorder p="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="xl" fw={700} c={color}>
        {value}
      </Text>
    </Card>
  );
}

function NoteList({ notes }: { notes: Note[] }) {
  return (
    <Stack gap={4}>
      {notes.map((n, i) => (
        <Text key={i} size="sm">
          <b>{n.file}</b>: {n.reason}
        </Text>
      ))}
    </Stack>
  );
}

function Results({ job, onSecondPass, starting }: { job: Job; onSecondPass: () => void; starting: boolean }) {
  const s = job.summary;
  const [show, setShow] = useState("flagged");
  const rows = (s.added ?? []).filter((r) => show === "all" || r.remarks);
  const offer = s.secondPassOffer;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <Stack>
      <SimpleGrid cols={{ base: 2, md: 5 }}>
        <Stat label="Rows added" value={s.encoded ?? 0} />
        <Stat label="For manual checking" value={s.manualChecking ?? 0} color={s.manualChecking ? "orange.7" : undefined} />
        <Stat label="Not encoded" value={(s.skipped?.length ?? 0) + (s.duplicates?.length ?? 0)} />
        <Stat label="Failed" value={s.failed?.length ?? 0} color={s.failed?.length ? "red.7" : undefined} />
        <Stat label="Cost" value={dollars(s.cost)} />
      </SimpleGrid>

      {offer && (
        <Alert color="violet" title={`${unit(offer.count, offer.unit)} could not be read cleanly`}>
          <Stack gap="sm">
            <Text size="sm">
              Sonnet reads handwriting and faint print better. Re-reading {offer.count === 1 ? "it" : "them"} costs about <b>{dollars(offer.estimate)}</b>.
              Rows that are still unclear afterwards stay marked for manual checking.
            </Text>
            {job.kind === "purchases" && (
              <Text size="xs" c="dimmed">
                The re-read rows replace this job's rows in the workbook, so do it before correcting them by hand. The workbook is backed up first.
              </Text>
            )}
            <Group>
              <Button color="violet" loading={starting} onClick={onSecondPass}>
                Re-read {unit(offer.count, offer.unit)} with Sonnet
              </Button>
              <Text size="xs" c="dimmed">
                or skip this and check them by hand
              </Text>
            </Group>
          </Stack>
        </Alert>
      )}
      {s.phase === "second" && (
        <Alert color="teal" variant="light">
          Second reading done: re-read {unit(s.reread ?? 0, job.summary.pages ? "page" : "document")}. Rows marked for manual checking went from{" "}
          {s.firstPass?.manualChecking ?? "?"} to {s.manualChecking ?? 0}.
        </Alert>
      )}

      {(s.workbooks ?? []).length > 0 && (
        <Group>
          {s.workbooks!.map((w) => (
            <Button key={w} variant="light" onClick={() => api.open(w).catch((err) => notifications.show({ color: "red", message: err.message }))}>
              Open {fileName(w)} in Excel
            </Button>
          ))}
        </Group>
      )}

      {(s.skipped?.length || s.duplicates?.length || s.failed?.length) ? (
        <Accordion variant="separated">
          {s.failed?.length ? (
            <Accordion.Item value="failed">
              <Accordion.Control>Failed ({s.failed.length})</Accordion.Control>
              <Accordion.Panel>
                <NoteList notes={s.failed} />
              </Accordion.Panel>
            </Accordion.Item>
          ) : null}
          {s.skipped?.length ? (
            <Accordion.Item value="skipped">
              <Accordion.Control>Not encoded ({s.skipped.length})</Accordion.Control>
              <Accordion.Panel>
                <NoteList notes={s.skipped} />
              </Accordion.Panel>
            </Accordion.Item>
          ) : null}
          {s.duplicates?.length ? (
            <Accordion.Item value="duplicates">
              <Accordion.Control>Already encoded before ({s.duplicates.length})</Accordion.Control>
              <Accordion.Panel>
                <NoteList notes={s.duplicates} />
              </Accordion.Panel>
            </Accordion.Item>
          ) : null}
        </Accordion>
      ) : null}

      <Group justify="space-between">
        <Title order={4}>Rows</Title>
        <SegmentedControl
          size="xs"
          value={show}
          onChange={setShow}
          data={[
            { value: "flagged", label: `For checking (${(s.added ?? []).filter((r) => r.remarks).length})` },
            { value: "all", label: `All (${s.added?.length ?? 0})` },
          ]}
        />
      </Group>
      <Table striped verticalSpacing={6} fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Source</Table.Th>
            <Table.Th>Month</Table.Th>
            <Table.Th>No.</Table.Th>
            <Table.Th>Company</Table.Th>
            <Table.Th ta="right">Amount</Table.Th>
            <Table.Th>Remarks</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r, i) => (
            <Table.Tr key={i} bg={r.remarks ? "orange.0" : undefined}>
              <Table.Td>
                <Text size="xs" maw={220} truncate title={r.source}>
                  {r.page && job.kind === "2307" ? `page ${r.page}` : r.source}
                </Text>
              </Table.Td>
              <Table.Td>{r.month}</Table.Td>
              <Table.Td>{r.number}</Table.Td>
              <Table.Td>{r.company}</Table.Td>
              <Table.Td ta="right">{peso(r.amount)}</Table.Td>
              <Table.Td>
                <Text size="xs" c={r.remarks ? "orange.9" : "dimmed"}>
                  {r.remarks.replace("FOR MANUAL CHECKING: ", "")}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {rows.length === 0 && (
        <Text c="dimmed" size="sm">
          {show === "flagged" ? "Nothing to check." : "No rows were added."}
        </Text>
      )}
    </Stack>
  );
}
