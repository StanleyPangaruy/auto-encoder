import { useEffect, useRef, useState } from "react";
import { ActionIcon, Alert, Button, Center, Group, Loader, Select, Stack, Text, Tooltip } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { review } from "../api";

const STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

/** The scan a row was read from, with zoom. Ctrl + mouse wheel zooms too. */
export function ScanViewer({ rowId, workbook }: { rowId: number; workbook: string }) {
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ["scan-info", rowId], queryFn: () => review.scanInfo(rowId) });
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [choice, setChoice] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const url = info.data?.url;

  useEffect(() => {
    setLoading(true);
  }, [url, rowId]);

  // Ctrl + wheel changes the zoom instead of zooming the whole page.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => {
        const i = STEPS.indexOf(z);
        return STEPS[Math.max(0, Math.min(STEPS.length - 1, i + (e.deltaY < 0 ? 1 : -1)))];
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const step = (d: number) => setZoom((z) => STEPS[Math.max(0, Math.min(STEPS.length - 1, STEPS.indexOf(z) + d))]);

  if (info.isLoading) return <Center h="100%"><Loader /></Center>;
  if (!info.data?.found) {
    const choices = info.data?.choices ?? [];
    return (
      <Center h="100%" p="lg">
        <Stack maw={420}>
          <Alert color="gray" title="Scan not found">
            {choices.length
              ? "Which PDF was this workbook made from? Choose it once and the app remembers."
              : "The file this row came from is not in the client's raw folder any more."}
          </Alert>
          {choices.length > 0 && (
            <Group align="flex-end">
              <Select label="PDF" data={choices} value={choice} onChange={setChoice} style={{ flex: 1 }} />
              <Button
                disabled={!choice}
                onClick={async () => {
                  await review.setPdf(workbook, choice!);
                  queryClient.invalidateQueries({ queryKey: ["scan-info"] });
                }}
              >
                Use it
              </Button>
            </Group>
          )}
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap={6} h="100%">
      <Group justify="space-between" px={4}>
        <Text size="xs" c="dimmed" truncate maw="60%" title={info.data.file}>
          {info.data.file}
          {info.data.page && info.data.page > 1 ? ` · page ${info.data.page}` : ""}
        </Text>
        <Group gap={4}>
            <Tooltip label="Smaller (Ctrl + wheel)">
              <ActionIcon variant="default" onClick={() => step(-1)} aria-label="Smaller">−</ActionIcon>
            </Tooltip>
            <Text size="xs" w={42} ta="center">
              {Math.round(zoom * 100)}%
            </Text>
            <Tooltip label="Bigger (Ctrl + wheel)">
              <ActionIcon variant="default" onClick={() => step(1)} aria-label="Bigger">+</ActionIcon>
            </Tooltip>
            <Button size="compact-xs" variant="subtle" onClick={() => setZoom(1)}>
              Fit
            </Button>
          </Group>
      </Group>
      <div ref={box} style={{ flex: 1, overflow: "auto", background: "var(--mantine-color-gray-1)", borderRadius: 8, position: "relative" }}>
        {loading && (
          <Center pos="absolute" inset={0}>
            <Loader size="sm" />
          </Center>
        )}
        <PdfOrImage url={url!} onLoad={() => setLoading(false)} zoom={zoom} />
      </div>
    </Stack>
  );
}

/**
 * Scans and photos arrive as pictures. A PDF page that is not a plain scan (an e-bill, or a PDF whose
 * pages are stored another way) arrives as a one-page PDF and is drawn here with pdf.js, so it zooms the
 * same way.
 */
function PdfOrImage({ url, onLoad, zoom }: { url: string; onLoad: () => void; zoom: number }) {
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [isImage, setIsImage] = useState(false);
  useEffect(() => {
    let alive = true;
    setPdf(null);
    setIsImage(false);
    fetch(url).then(async (r) => {
      if (!alive) return;
      if ((r.headers.get("content-type") ?? "").includes("pdf")) setPdf(await r.arrayBuffer());
      else setIsImage(true);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  if (pdf) return <PdfPage data={pdf} zoom={zoom} onLoad={onLoad} />;
  if (!isImage) return null;
  return <img src={url} alt="scan" onLoad={onLoad} style={{ width: `${zoom * 100}%`, display: "block", margin: "0 auto" }} />;
}

function PdfPage({ data, zoom, onLoad }: { data: ArrayBuffer; zoom: number; onLoad: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      // pdf.js takes ownership of the buffer it is given, so it gets a copy.
      const doc = await pdfjs.getDocument({ data: data.slice(0) }).promise;
      const page = await doc.getPage(1);
      if (cancelled || !canvas.current || !holder.current) return;
      // At 100% the page fills the panel's width; drawn at twice that for sharp text.
      const base = page.getViewport({ scale: 1 });
      const fit = holder.current.clientWidth / base.width;
      const viewport = page.getViewport({ scale: fit * zoom * 2 });
      canvas.current.width = viewport.width;
      canvas.current.height = viewport.height;
      canvas.current.style.width = `${viewport.width / 2}px`;
      await page.render({ canvasContext: canvas.current.getContext("2d")!, viewport }).promise;
      if (!cancelled) onLoad();
    })();
    return () => {
      cancelled = true;
    };
  }, [data, zoom]);
  return (
    <div ref={holder} style={{ width: "100%" }}>
      <canvas ref={canvas} style={{ display: "block", margin: "0 auto" }} />
    </div>
  );
}
