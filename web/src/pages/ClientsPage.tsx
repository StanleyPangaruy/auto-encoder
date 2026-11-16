import { useState } from "react";
import { Badge, Button, Group, Modal, Radio, Select, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, MODELS, modelName, type Client, type ClientInput } from "../api";

const EMPTY: ClientInput = { buyerName: "", buyerTin: "", model: "claude-haiku-5-5", layout: "month", addressStyle: "district", inventoryHint: "", folder: "" };

const formatTin = (tin: string) => tin.replace(/^(\d{3})(\d{3})(\d{3})$/, "$1-$2-$3");

export function ClientsPage() {
  const clients = useQuery({ queryKey: ["clients"], queryFn: api.clients });
  const [editing, setEditing] = useState<Client | "new" | null>(null);

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={2}>Clients</Title>
          <Text c="dimmed" size="sm">
            Who documents are encoded for, and how their workbooks are laid out.
          </Text>
        </div>
        <Button onClick={() => setEditing("new")}>Add client</Button>
      </Group>

      <Table striped highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Client</Table.Th>
            <Table.Th>TIN</Table.Th>
            <Table.Th>Reads with</Table.Th>
            <Table.Th>Workbook layout</Table.Th>
            <Table.Th>Address</Table.Th>
            <Table.Th>Folders</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {clients.data?.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td>
                <Text fw={600}>{c.buyerName}</Text>
              </Table.Td>
              <Table.Td style={{ whiteSpace: "nowrap" }}>{formatTin(c.buyerTin)}</Table.Td>
              <Table.Td>
                <Badge variant="light" color={c.model.includes("sonnet") ? "violet" : "teal"} style={{ flexShrink: 0 }} miw={70}>
                  {modelName(c.model)}
                </Badge>
              </Table.Td>
              <Table.Td>{c.layout === "file-order" ? "One sheet per folder, file order" : "One sheet per month"}</Table.Td>
              <Table.Td>{c.addressStyle === "full" ? "Full address" : "District only"}</Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {c.rawDir}
                  <br />
                  {c.outputDir}
                </Text>
              </Table.Td>
              <Table.Td>
                <Button variant="subtle" size="xs" onClick={() => setEditing(c)}>
                  Edit
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      {editing && <ClientForm client={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}

function ClientForm({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ClientInput>(client ? { ...client } : EMPTY);
  const set = <K extends keyof ClientInput>(key: K, value: ClientInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const tinDigits = form.buyerTin.replace(/\D/g, "");

  const save = useMutation({
    mutationFn: () => (client ? api.updateClient(client.id, form) : api.createClient(form)),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      notifications.show({ color: "teal", message: `${saved.buyerName} saved` });
      onClose();
    },
    onError: (err: Error) => notifications.show({ color: "red", title: "Not saved", message: err.message }),
  });

  return (
    <Modal opened onClose={onClose} title={<Title order={3}>{client ? "Edit client" : "Add client"}</Title>} size="lg">
      <Stack>
        <TextInput label="Registered name" description="As it appears in the Sold to box" required value={form.buyerName} onChange={(e) => set("buyerName", e.currentTarget.value)} />
        <TextInput
          label="TIN"
          description="The first 9 digits are enough"
          value={form.buyerTin}
          onChange={(e) => set("buyerTin", e.currentTarget.value)}
          error={tinDigits && tinDigits.length < 9 ? "A TIN has 9 digits" : undefined}
        />
        {!client && (
          <TextInput
            label="Folder name"
            description="Used for this client's scans (raw/...) and workbooks (output/...). Leave empty to use the name."
            value={form.folder}
            onChange={(e) => set("folder", e.currentTarget.value)}
          />
        )}
        <Select label="Read documents with" data={MODELS} value={form.model} onChange={(v) => v && set("model", v)} allowDeselect={false} />
        <Radio.Group label="Purchases workbook layout" value={form.layout} onChange={(v) => set("layout", v as ClientInput["layout"])}>
          <Stack gap={6} mt={6}>
            <Radio value="month" label="One sheet per month, rows sorted by date" />
            <Radio value="file-order" label="One sheet per folder, rows in the order of the files" />
          </Stack>
        </Radio.Group>
        <Radio.Group label="Supplier address" value={form.addressStyle} onChange={(v) => set("addressStyle", v as ClientInput["addressStyle"])}>
          <Stack gap={6} mt={6}>
            <Radio value="district" label="District only (ADDRESS: Binondo, CITY: Manila)" />
            <Radio value="full" label="Full address (ADDRESS: street to municipality, CITY: province or city)" />
          </Stack>
        </Radio.Group>
        <Textarea
          label="What counts as inventory for this client"
          description="Helps the reader choose INVENTORY, for example: groceries and other merchandise for a supermarket"
          autosize
          minRows={2}
          value={form.inventoryHint}
          onChange={(e) => set("inventoryHint", e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!form.buyerName.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
