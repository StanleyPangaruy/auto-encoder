import { Badge, Group, Select, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, dollars, fileName } from "../api";

const STATUS_COLOR = { queued: "gray", running: "blue", done: "teal", failed: "red" } as const;

export function JobsPage() {
  const navigate = useNavigate();
  const [clientId, setClientId] = useState<string | null>(null);
  const clients = useQuery({ queryKey: ["clients"], queryFn: api.clients });
  // Running jobs refresh every few seconds so their status moves on its own.
  const jobs = useQuery({
    queryKey: ["jobs", clientId],
    queryFn: () => api.jobs(clientId ?? undefined),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "running" || j.status === "queued") ? 3000 : false),
  });
  const name = (id: string) => clients.data?.find((c) => c.id === id)?.buyerName ?? id;

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Jobs</Title>
          <Text c="dimmed" size="sm">
            Every encoding run started from the app, newest first.
          </Text>
        </div>
        <Select
          placeholder="All clients"
          clearable
          data={(clients.data ?? []).map((c) => ({ value: c.id, label: c.buyerName }))}
          value={clientId}
          onChange={setClientId}
          w={320}
        />
      </Group>

      <Table striped highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Started</Table.Th>
            <Table.Th>Client</Table.Th>
            <Table.Th>Documents</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th ta="right">Rows</Table.Th>
            <Table.Th ta="right">For checking</Table.Th>
            <Table.Th ta="right">Cost</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {jobs.data?.map((j) => (
            <Table.Tr key={j.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/jobs/${j.id}`)}>
              <Table.Td style={{ whiteSpace: "nowrap" }}>{new Date(j.createdAt + "Z").toLocaleString()}</Table.Td>
              <Table.Td>{name(j.clientId)}</Table.Td>
              <Table.Td>{j.kind === "2307" ? "BIR 2307" : "Purchases"}</Table.Td>
              <Table.Td>
                <Text size="sm" maw={260} truncate title={j.source}>
                  {fileName(j.source)}
                </Text>
              </Table.Td>
              <Table.Td ta="right">{j.summary.encoded ?? ""}</Table.Td>
              <Table.Td ta="right">{j.summary.manualChecking ?? ""}</Table.Td>
              <Table.Td ta="right">{j.summary.cost != null ? dollars(j.summary.cost) : ""}</Table.Td>
              <Table.Td>
                <Badge color={STATUS_COLOR[j.status]} variant="light" miw={j.summary.secondPassOffer ? 150 : 70}>
                  {j.status === "done" && j.summary.secondPassOffer ? "done, re-read offered" : j.status}
                </Badge>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {jobs.data?.length === 0 && (
        <Text c="dimmed" size="sm">
          No jobs yet. Start one from Encode.
        </Text>
      )}
    </Stack>
  );
}
