import { useState } from "react";
import { Alert, Badge, Button, Group, Paper, PasswordInput, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, dollars } from "../api";

const monthName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-PH", { month: "long", year: "numeric" });

export function SettingsPage() {
  return (
    <Stack maw={900}>
      <div>
        <Title order={2}>Settings</Title>
        <Text c="dimmed" size="sm">
          The Anthropic key the app reads with, and what reading has cost.
        </Text>
      </div>
      <ApiKeyCard />
      <CostsCard />
    </Stack>
  );
}

function ApiKeyCard() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [key, setKey] = useState("");
  const [result, setResult] = useState<{ ok: boolean; reason?: string } | null>(null);
  const status = settings.data?.apiKey;

  const test = useMutation({ mutationFn: api.testKey, onSuccess: setResult });
  const save = useMutation({
    mutationFn: () => api.saveKey(key),
    onSuccess: () => {
      setKey("");
      setResult({ ok: true });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
      notifications.show({ color: "teal", message: "The new key works and is saved." });
    },
    onError: (err: Error) => setResult({ ok: false, reason: err.message }),
  });

  return (
    <Paper withBorder p="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={4}>Anthropic API key</Title>
          {status && (status.set ? <Badge color="teal">set, ends in …{status.ending}</Badge> : <Badge color="red">not set</Badge>)}
        </Group>
        <Text size="sm" c="dimmed">
          The key pays for reading documents. It is kept in this PC's app folder and only ever sent to Anthropic. Get or renew one at
          console.anthropic.com, under API keys.
        </Text>
        <Group align="flex-end">
          <PasswordInput
            label={status?.set ? "Replace with a new key" : "Paste the key"}
            placeholder="sk-ant-..."
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button disabled={!key.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Check and save
          </Button>
        </Group>
        <Group>
          <Button variant="default" size="xs" disabled={!status?.set} loading={test.isPending} onClick={() => test.mutate()}>
            Test the current key
          </Button>
          <Text size="xs" c="dimmed">
            Testing costs nothing.
          </Text>
        </Group>
        {result && (
          <Alert color={result.ok ? "teal" : "red"} variant="light">
            {result.ok ? "Anthropic accepted the key." : result.reason}
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}

function CostsCard() {
  const costs = useQuery({ queryKey: ["costs"], queryFn: api.costs });
  const clients = useQuery({ queryKey: ["clients"], queryFn: api.clients });
  const name = (id: string) => clients.data?.find((c) => c.id === id)?.buyerName ?? id;
  const months = [...new Set((costs.data ?? []).map((c) => c.month))];

  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={4}>Costs</Title>
        <Text size="sm" c="dimmed">
          What Anthropic charged for reading, per client per month, in US dollars. Re-running documents that were already read costs nothing.
          Spending before November 2026 was not recorded here; Anthropic's console has the full history and the actual bill.
        </Text>
        {months.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing recorded yet.
          </Text>
        ) : (
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Month</Table.Th>
                <Table.Th>Client</Table.Th>
                <Table.Th ta="right">Readings</Table.Th>
                <Table.Th ta="right">Cost</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {months.map((month) => {
                const rows = costs.data!.filter((c) => c.month === month);
                return [
                  ...rows.map((c, i) => (
                    <Table.Tr key={`${month}-${c.client_id}`}>
                      <Table.Td fw={i === 0 ? 600 : undefined}>{i === 0 ? monthName(month) : ""}</Table.Td>
                      <Table.Td>{name(c.client_id)}</Table.Td>
                      <Table.Td ta="right">{c.calls}</Table.Td>
                      <Table.Td ta="right">{dollars(c.cost)}</Table.Td>
                    </Table.Tr>
                  )),
                  <Table.Tr key={`${month}-total`} bg="gray.0">
                    <Table.Td />
                    <Table.Td fw={600}>Total</Table.Td>
                    <Table.Td ta="right">{rows.reduce((s, c) => s + c.calls, 0)}</Table.Td>
                    <Table.Td ta="right" fw={600}>
                      {dollars(rows.reduce((s, c) => s + c.cost, 0))}
                    </Table.Td>
                  </Table.Tr>,
                ];
              })}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Paper>
  );
}
