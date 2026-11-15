import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { Button } from "./button";
import logger from "@/lib/logger";

interface RealtimePlaybackProps {
  onChunk?: (event: BlobEvent) => void;
  isRecording?: boolean;
}

export interface RealtimePlaybackRef {
  handleChunk: (event: BlobEvent) => void;
}

export const RealtimePlayback = forwardRef<RealtimePlaybackRef, RealtimePlaybackProps>(
  ({ onChunk, isRecording = false }, ref) => {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const mediaSourceRef = useRef<MediaSource | null>(null);
    const sourceBufferRef = useRef<SourceBuffer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const chunksQueueRef = useRef<ArrayBuffer[]>([]);
    const isAppendingRef = useRef(false);

    useEffect(() => {
      const setupMediaSource = () => {
        logger.info("RealtimePlayback: Setting up MediaSource");

        // Clean up previous setup
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = "";
          logger.debug("RealtimePlayback: Cleaned up previous audio element");
        }

        const audio = document.createElement("audio");
        audio.controls = true;
        audio.className = "w-full";
        audioRef.current = audio;

        const mediaSource = new MediaSource();
        mediaSourceRef.current = mediaSource;
        audio.src = URL.createObjectURL(mediaSource);
        logger.debug("RealtimePlayback: MediaSource created and attached");

        mediaSource.addEventListener("sourceopen", () => {
          logger.info("RealtimePlayback: MediaSource opened");
          try {
            sourceBufferRef.current = mediaSource.addSourceBuffer("audio/webm; codecs=opus");
            logger.debug("RealtimePlayback: SourceBuffer created with audio/webm; codecs=opus");

            sourceBufferRef.current.addEventListener("updateend", () => {
              logger.debug("RealtimePlayback: SourceBuffer update ended");
              isAppendingRef.current = false;
              processQueue();
            });

            setIsReady(true);
            logger.info("RealtimePlayback: Ready for streaming");
          } catch (error) {
            logger.error("RealtimePlayback: Error setting up source buffer:", error);
            console.error("Error setting up source buffer:", error);
          }
        });

        mediaSource.addEventListener("sourceclose", () => {
          logger.info("RealtimePlayback: MediaSource closed");
          setIsReady(false);
        });
      };

      setupMediaSource();

      return () => {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = "";
        }
        if (mediaSourceRef.current && mediaSourceRef.current.readyState === "open") {
          try {
            mediaSourceRef.current.endOfStream();
          } catch (error) {
            console.error("Error ending stream:", error);
          }
        }
        chunksQueueRef.current = [];
      };
    }, []);

    const processQueue = () => {
      if (
        isAppendingRef.current ||
        chunksQueueRef.current.length === 0 ||
        !sourceBufferRef.current
      ) {
        return;
      }

      const chunk = chunksQueueRef.current.shift();
      if (chunk) {
        try {
          isAppendingRef.current = true;
          sourceBufferRef.current.appendBuffer(chunk);
        } catch (error) {
          console.error("Error appending buffer:", error);
          isAppendingRef.current = false;
        }
      }
    };

    const handleChunk = async (event: BlobEvent) => {
      if (!isReady || !sourceBufferRef.current || !event.data || event.data.size === 0) {
        logger.debug("RealtimePlayback: Chunk ignored", {
          isReady,
          hasSourceBuffer: !!sourceBufferRef.current,
          hasData: !!event.data,
          dataSize: event.data?.size,
        });
        return;
      }

      try {
        logger.debug(`RealtimePlayback: Processing chunk of ${event.data.size} bytes`);
        const arrayBuffer = await event.data.arrayBuffer();
        chunksQueueRef.current.push(arrayBuffer);
        logger.debug(
          `RealtimePlayback: Chunk queued, queue size: ${chunksQueueRef.current.length}`,
        );

        if (!isAppendingRef.current) {
          processQueue();
        }

        // Call the original onChunk callback if provided
        onChunk?.(event);
      } catch (error) {
        logger.error("RealtimePlayback: Error processing chunk:", error);
        console.error("Error processing chunk:", error);
      }
    };

    // Expose handleChunk through ref
    useImperativeHandle(ref, () => ({
      handleChunk,
    }));

    const togglePlayback = () => {
      if (!audioRef.current) {
        logger.warn("RealtimePlayback: Toggle requested but no audio element");
        return;
      }

      if (isPlaying) {
        logger.info("RealtimePlayback: Pause button clicked");
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        logger.info("RealtimePlayback: Play button clicked");
        audioRef.current.play().catch((error) => {
          logger.error("RealtimePlayback: Error playing audio:", error);
          console.error("Error playing audio:", error);
        });
        setIsPlaying(true);
      }
    };

    const stopPlayback = () => {
      logger.info("RealtimePlayback: Stop button clicked");

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        setIsPlaying(false);
        logger.debug("RealtimePlayback: Audio stopped and reset");
      }

      // Clear the queue
      const queueSize = chunksQueueRef.current.length;
      chunksQueueRef.current = [];
      logger.debug(`RealtimePlayback: Cleared queue of ${queueSize} chunks`);

      // End the stream if it's open
      if (mediaSourceRef.current && mediaSourceRef.current.readyState === "open") {
        try {
          mediaSourceRef.current.endOfStream();
          logger.debug("RealtimePlayback: MediaSource stream ended");
        } catch (error) {
          logger.error("RealtimePlayback: Error ending stream:", error);
          console.error("Error ending stream:", error);
        }
      }
    };

    // Effect to handle audio events
    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;

      const handlePlay = () => setIsPlaying(true);
      const handlePause = () => setIsPlaying(false);
      const handleEnded = () => setIsPlaying(false);

      audio.addEventListener("play", handlePlay);
      audio.addEventListener("pause", handlePause);
      audio.addEventListener("ended", handleEnded);

      return () => {
        audio.removeEventListener("play", handlePlay);
        audio.removeEventListener("pause", handlePause);
        audio.removeEventListener("ended", handleEnded);
      };
    }, []);

    return (
      <div className="border border-dashed border-muted-foreground/50 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">Real-time Audio Preview</h3>
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${isRecording ? "bg-red-500 animate-pulse" : "bg-gray-400"}`}
            />
            <span className="text-xs text-muted-foreground">
              {isRecording ? "Recording" : "Idle"}
            </span>
          </div>
        </div>

        {audioRef.current && (
          <div
            ref={(node) => {
              if (node && audioRef.current && !node.contains(audioRef.current)) {
                node.appendChild(audioRef.current);
              }
            }}
          />
        )}

        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={togglePlayback} disabled={!isReady}>
            {isPlaying ? "Pause" : "Play"}
          </Button>

          <Button size="sm" variant="outline" onClick={stopPlayback} disabled={!isReady}>
            Stop
          </Button>

          <div className="flex-1" />

          <span className="text-xs text-muted-foreground self-center">
            {isReady ? "Ready" : "Initializing..."}
          </span>
        </div>
      </div>
    );
  },
);

RealtimePlayback.displayName = "RealtimePlayback";

export default RealtimePlayback;
