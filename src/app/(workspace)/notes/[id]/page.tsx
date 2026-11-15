import { NoteEditor } from "@/components/workspace/NoteEditor";
import { idSchema } from "@/contracts/workspace";
import { MAX_RECORDING_SECONDS } from "@/contracts/recording-processing";

export default async function NotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recordingId?: string; at?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const recording = idSchema.safeParse(query.recordingId);
  const seconds = query.at === undefined ? 0 : Number(query.at);
  const initialPlayback =
    recording.success &&
    Number.isFinite(seconds) &&
    seconds >= 0 &&
    seconds <= MAX_RECORDING_SECONDS
      ? { recordingId: recording.data, seconds }
      : undefined;
  return <NoteEditor key={id} noteId={id} initialPlayback={initialPlayback} />;
}
