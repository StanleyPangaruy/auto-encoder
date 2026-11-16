import { AppShell, Alert, Group, NavLink, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { NavLink as RouterLink, Navigate, Route, Routes, useLocation } from "react-router";
import { api } from "./api";
import { ClientsPage } from "./pages/ClientsPage";
import { EncodePage } from "./pages/EncodePage";
import { JobPage } from "./pages/JobPage";
import { JobsPage } from "./pages/JobsPage";

const PAGES = [
  { to: "/encode", label: "Encode", hint: "Read new documents" },
  { to: "/jobs", label: "Jobs", hint: "What has been encoded" },
  { to: "/clients", label: "Clients", hint: "Add or change a client" },
];

export function App() {
  const location = useLocation();
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });

  return (
    <AppShell navbar={{ width: 230, breakpoint: "sm" }} header={{ height: 56 }} padding="lg">
      <AppShell.Header>
        <Group h="100%" px="lg">
          <Title order={3} c="teal.8">
            Auto-Encoder
          </Title>
          <Text size="sm" c="dimmed">
            purchases and BIR 2307, read from scans
          </Text>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        {PAGES.map((page) => (
          <NavLink
            key={page.to}
            component={RouterLink}
            to={page.to}
            label={page.label}
            description={page.hint}
            active={location.pathname.startsWith(page.to)}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main>
        {status.data && !status.data.apiKey && (
          <Alert color="red" mb="md" title="No Anthropic API key">
            Put the key in the .env file in the app folder (ANTHROPIC_API_KEY=...), then restart the app.
          </Alert>
        )}
        {status.isError && (
          <Alert color="red" mb="md" title="The app server is not answering">
            Start the app again from its desktop shortcut.
          </Alert>
        )}
        <Routes>
          <Route path="/" element={<Navigate to="/encode" replace />} />
          <Route path="/encode" element={<EncodePage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="*" element={<Navigate to="/encode" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
