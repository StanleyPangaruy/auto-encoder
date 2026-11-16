import { useState } from "react";
import { AppShell, Alert, Anchor, Button, Center, Group, NavLink, Stack, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery } from "@tanstack/react-query";
import { NavLink as RouterLink, Navigate, Route, Routes, useLocation } from "react-router";
import { api, dollars } from "./api";
import { ClientsPage } from "./pages/ClientsPage";
import { EncodePage } from "./pages/EncodePage";
import { JobPage } from "./pages/JobPage";
import { JobsPage } from "./pages/JobsPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage } from "./pages/SettingsPage";

const PAGES = [
  { to: "/encode", label: "Encode", hint: "Read new documents" },
  { to: "/review", label: "Review", hint: "Check rows against the scans" },
  { to: "/jobs", label: "Jobs", hint: "What has been encoded" },
  { to: "/clients", label: "Clients", hint: "Add or change a client" },
  { to: "/settings", label: "Settings", hint: "API key and costs" },
];

export function App() {
  const location = useLocation();
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 60000 });
  const [stopped, setStopped] = useState(false);

  // The app runs without a window, so this is how it is stopped.
  const quit = async (force = false) => {
    try {
      await api.quit(force);
      setStopped(true);
    } catch (err) {
      modals.openConfirmModal({
        title: "A job is still running",
        children: <Text size="sm">{(err as Error).message}</Text>,
        labels: { confirm: "Quit anyway", cancel: "Keep running" },
        confirmProps: { color: "red" },
        onConfirm: () => quit(true),
      });
    }
  };

  if (stopped) {
    return (
      <Center h="100vh">
        <Stack align="center">
          <Title order={2}>Auto-Encoder has stopped</Title>
          <Text c="dimmed">You can close this tab. Start it again from the desktop shortcut.</Text>
        </Stack>
      </Center>
    );
  }

  return (
    <AppShell navbar={{ width: 230, breakpoint: "sm" }} header={{ height: 56 }} padding="lg">
      <AppShell.Header>
        <Group h="100%" px="lg">
          <Title order={3} c="teal.8">
            Auto-Encoder
          </Title>
          <Text size="sm" c="dimmed" style={{ flex: 1 }}>
            purchases and BIR 2307, read from scans
          </Text>
          {status.data && (
            <Text size="sm" c="dimmed">
              This month: {dollars(status.data.costThisMonth)}
            </Text>
          )}
          <Button
            variant="default"
            size="xs"
            onClick={() =>
              modals.openConfirmModal({
                title: "Quit Auto-Encoder?",
                children: <Text size="sm">The app stops until it is started again from the desktop shortcut.</Text>,
                labels: { confirm: "Quit", cancel: "Cancel" },
                onConfirm: () => quit(),
              })
            }
          >
            Quit
          </Button>
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
            Nothing can be read until a key is set up.{" "}
            <Anchor component={RouterLink} to="/settings">
              Set it up in Settings
            </Anchor>
            .
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
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/encode" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
