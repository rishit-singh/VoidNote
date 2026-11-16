"use client";

import { useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { motion, type Variants } from "motion/react";
import {
  ArrowRightIcon,
  CheckIcon,
  FileTextIcon,
  LoopIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { SignIn } from "@/components/SignIn";
import { Brand, PlayMark, Waveform } from "@/assets";

const MotionButton = motion.create(Button);
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

// Motion's current hook snapshots this setting; subscribe so open pages respond too.
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getReducedMotion() {
  return window.matchMedia(reducedMotionQuery).matches;
}

function getServerReducedMotion() {
  return true;
}

const reveal: Variants = {
  rest: { opacity: 1, y: 0, transition: { duration: 0 } },
  play: (delay: number = 0) => ({
    opacity: [0.3, 1],
    y: [8, 0],
    transition: { duration: 0.55, delay, ease: "easeOut" },
  }),
};
const sourceEmphasis: Variants = {
  rest: { backgroundColor: "rgba(184, 212, 196, 0)", transition: { duration: 0 } },
  play: {
    backgroundColor: [
      "rgba(184, 212, 196, 0)",
      "rgba(184, 212, 196, 0.14)",
      "rgba(184, 212, 196, 0)",
    ],
    transition: { duration: 1.6, delay: 0.2, times: [0, 0.35, 1] },
  },
};

function ProductDemo({
  replay,
  onReplay,
  reduceMotion,
}: {
  replay: number;
  onReplay: () => void;
  reduceMotion: boolean;
}) {
  return (
    <figure
      className="relative overflow-hidden rounded-[5px] border border-vn-stroke-strong bg-vn-sidebar"
      aria-label="Illustrated sample of a conversation transcribed in VoidNote"
    >
      <div className="flex h-11 items-center justify-between border-b border-vn-stroke px-5 text-[9px] tracking-[0.12em] text-vn-muted [@media(max-width:640px)]:gap-3 [@media(max-width:640px)]:px-3.5 [@media(max-width:640px)]:text-[10px] [@media(max-width:640px)]:tracking-[0.04em]">
        <div className="flex gap-1.5 [@media(max-width:640px)]:hidden" aria-hidden="true">
          <i className="size-1.5 rounded-full border border-vn-stroke-strong" />
          <i className="size-1.5 rounded-full border border-vn-stroke-strong" />
          <i className="size-1.5 rounded-full border border-vn-stroke-strong" />
        </div>
        <span>RECORDING / TRANSCRIPT</span>
        <span className="text-[8px] text-vn-mint [@media(max-width:640px)]:text-[10px]">DEMO</span>
      </div>
      <div
        className="grid grid-cols-[224px_minmax(0,1fr)] max-[900px]:grid-cols-[180px_minmax(0,1fr)] [@media(max-width:640px)]:grid-cols-1"
        key={replay}
      >
        <aside
          className="flex flex-col border-r border-vn-stroke px-3.5 pb-[22px] pt-8 [@media(max-width:640px)]:hidden"
          aria-hidden="true"
        >
          <span className="px-2.5 pb-5 text-[10px] text-vn-muted">Recordings</span>
          <span className="flex items-center gap-[9px] rounded-[3px] border border-vn-stroke bg-vn-surface px-2.5 py-[11px] text-[10px] text-vn-text [@media(max-width:900px)]:text-[8px]">
            <FileTextIcon className="size-[13px] flex-none" /> Launch review
          </span>
          <span className="flex items-center gap-[9px] px-2.5 py-[11px] text-[10px] text-vn-muted [@media(max-width:900px)]:text-[8px]">
            <FileTextIcon className="size-[13px] flex-none" /> Scope review
          </span>
          <span className="flex items-center gap-[9px] px-2.5 py-[11px] text-[10px] text-vn-muted [@media(max-width:900px)]:text-[8px]">
            <FileTextIcon className="size-[13px] flex-none" /> Weekly sync
          </span>
          <span className="px-2.5 pb-2 pt-7 text-[10px] text-vn-muted">Speaker profiles</span>
          <span className="flex items-center gap-[9px] px-2.5 py-[11px] text-[10px] text-vn-muted [@media(max-width:900px)]:text-[8px]">
            <PersonIcon className="size-[13px] flex-none" /> Jamie
          </span>
          <span className="flex items-center gap-[9px] px-2.5 py-[11px] text-[10px] text-vn-muted [@media(max-width:900px)]:text-[8px]">
            <PersonIcon className="size-[13px] flex-none" /> Alex
          </span>
          <span className="mt-auto flex items-center gap-[9px] px-2.5 pt-5 text-[9px] text-vn-muted">
            <span className="grid size-6 place-items-center rounded-full bg-vn-surface text-vn-mint">
              J
            </span>{" "}
            Workspace
          </span>
        </aside>
        <div className="min-w-0 bg-vn-page px-11 pb-8 pt-7 max-[900px]:p-[26px] [@media(max-width:640px)]:px-4 [@media(max-width:640px)]:pb-6 [@media(max-width:640px)]:pt-5">
          <div className="flex items-center justify-between text-[8px] tracking-[0.04em] text-vn-muted [@media(max-width:640px)]:flex-wrap [@media(max-width:640px)]:gap-3 [@media(max-width:640px)]:text-[10px]">
            <span>CONVERSATIONS / 001</span>
            <span className="inline-flex items-center gap-[5px] text-vn-mint">
              <CheckIcon className="size-3" /> Saved
            </span>
          </div>
          <h2 className="mt-[26px] text-[23px] font-normal tracking-[-0.055em] [@media(max-width:640px)]:mt-5 [@media(max-width:640px)]:text-[21px]">
            Launch review
          </h2>
          <p className="mt-[7px] text-[9px] text-vn-muted [@media(max-width:640px)]:text-[11px]">
            Today · 2 speakers
          </p>
          <div className="mb-[27px] mt-6 flex items-center gap-[17px] rounded border border-vn-stroke px-3.5 py-[11px] [@media(max-width:640px)]:my-5 [@media(max-width:640px)]:gap-2.5 [@media(max-width:640px)]:px-2.5 [@media(max-width:640px)]:py-2">
            <span
              className="grid size-7 flex-none place-items-center rounded-full bg-vn-mint/[0.062745098] text-vn-mint"
              aria-hidden="true"
            >
              <PlayMark className="size-3" />
            </span>
            <Waveform reduceMotion={reduceMotion} />
            <span className="text-[9px] text-vn-muted [@media(max-width:640px)]:flex-none [@media(max-width:640px)]:text-[11px]">
              02:34
            </span>
          </div>
          <motion.div
            className="flex flex-col gap-[21px]"
            initial="rest"
            whileInView={reduceMotion ? "rest" : "play"}
            viewport={{ once: true, amount: 0.4 }}
          >
            <motion.div className="vn-demo-passage" variants={reveal} custom={0.1}>
              <div className="flex items-center gap-[7px] text-[10px] text-vn-mint [@media(max-width:640px)]:text-[12px]">
                <span className="size-[5px] rounded-full bg-vn-mint" />{" "}
                <a href="#profiles">Jamie ↗</a>{" "}
                <time className="ml-[5px] text-[8px] text-vn-muted [@media(max-width:640px)]:text-[11px]">
                  00:08
                </time>
              </div>
              <p className="ml-3 mt-[7px] max-w-[540px] text-xs leading-[1.85] text-vn-secondary [@media(max-width:640px)]:text-[13px] [@media(max-width:640px)]:leading-[1.7]">
                We need the <strong className="font-medium text-vn-text">review complete</strong>{" "}
                before launch.
              </p>
            </motion.div>
            <motion.div className="vn-demo-passage" variants={reveal} custom={0.45}>
              <div className="flex items-center gap-[7px] text-[10px] text-vn-mint [@media(max-width:640px)]:text-[12px]">
                <span className="size-[5px] rounded-full bg-vn-blue" /> Alex{" "}
                <time className="ml-[5px] text-[8px] text-vn-muted [@media(max-width:640px)]:text-[11px]">
                  00:16
                </time>
              </div>
              <p className="ml-3 mt-[7px] max-w-[540px] text-xs leading-[1.85] text-vn-secondary [@media(max-width:640px)]:text-[13px] [@media(max-width:640px)]:leading-[1.7]">
                I’ll send the{" "}
                <span className="bg-vn-mint/[0.074509804] text-vn-text shadow-[0_1px_0_#b8d4c440]">
                  revised scope on Thursday.
                </span>
              </p>
            </motion.div>
            <motion.div className="vn-demo-passage" variants={reveal} custom={0.8}>
              <div className="flex items-center gap-[7px] text-[10px] text-vn-mint [@media(max-width:640px)]:text-[12px]">
                <span className="size-[5px] rounded-full bg-vn-mint" /> Jamie{" "}
                <time className="ml-[5px] text-[8px] text-vn-muted [@media(max-width:640px)]:text-[11px]">
                  00:24
                </time>
              </div>
              <p className="ml-3 mt-[7px] max-w-[540px] text-xs leading-[1.85] text-vn-secondary [@media(max-width:640px)]:text-[13px] [@media(max-width:640px)]:leading-[1.7]">
                Then we can confirm the launch date.
              </p>
            </motion.div>
          </motion.div>
        </div>
      </div>
      <figcaption className="flex items-center justify-between gap-3 border-t border-vn-stroke px-[18px] py-[9px] text-[9px] text-vn-muted [@media(max-width:640px)]:flex-wrap [@media(max-width:640px)]:gap-2 [@media(max-width:640px)]:px-2.5">
        <span className="inline-flex items-center gap-2 [@media(max-width:640px)]:gap-[5px] [@media(max-width:640px)]:text-[10px]">
          Sample recording
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="[@media(max-width:640px)]:min-h-11"
          onClick={onReplay}
        >
          <LoopIcon data-icon="inline-start" /> Replay demo
        </Button>
      </figcaption>
    </figure>
  );
}

function ProfileDemo({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.figure
      id="profiles"
      className="min-w-0 scroll-mt-6 overflow-hidden rounded-[6px] border border-vn-stroke-strong bg-vn-sidebar"
      aria-label="Sample profile showing Jamie's words across two conversations"
      initial="rest"
      whileInView={reduceMotion ? "rest" : "play"}
      viewport={{ once: true, amount: 0.4 }}
    >
      <div className="flex justify-between gap-3 border-b border-vn-stroke px-6 py-4 text-[8px] tracking-[0.06em] text-vn-muted [@media(max-width:640px)]:px-4 [@media(max-width:640px)]:py-3.5 [@media(max-width:640px)]:text-[10px]">
        <span>SPEAKER PROFILE</span>
        <span className="text-vn-mint">DEMO</span>
      </div>
      <div className="flex items-center gap-[15px] px-6 py-[27px] [@media(max-width:640px)]:px-4 [@media(max-width:640px)]:py-5">
        <span className="grid size-[46px] flex-none place-items-center rounded-full border border-vn-mint/[0.133333333] bg-vn-mint/[0.062745098] text-[19px] text-vn-mint">
          J
        </span>
        <div>
          <h2 className="text-[21px] tracking-[-0.04em]">Jamie</h2>
          <p className="mt-[5px] text-[9px] leading-[1.7] text-vn-muted [@media(max-width:640px)]:text-[11px]">
            2 recordings
          </p>
        </div>
      </div>
      <div className="mx-6 border-t border-vn-stroke py-[17px] [@media(max-width:640px)]:mx-4 [@media(max-width:640px)]:py-4">
        <a
          className="flex items-center gap-2 text-[10px] text-vn-secondary [@media(max-width:640px)]:min-h-11 [@media(max-width:640px)]:text-[12px]"
          href="#demo"
        >
          <FileTextIcon className="size-[13px] flex-none" />
          <span className="flex-1">Launch review</span>
          <ArrowRightIcon className="size-[13px] flex-none" />
        </a>
        <motion.blockquote
          className="my-3 text-[11px] leading-[1.9] text-vn-muted [@media(max-width:640px)]:text-[13px] [@media(max-width:640px)]:leading-[1.7]"
          variants={sourceEmphasis}
        >
          “We need the <strong className="font-medium text-vn-text">review complete</strong> before
          launch.”
        </motion.blockquote>
        <span className="flex items-center gap-[7px] text-[8px] text-vn-mint [@media(max-width:640px)]:text-[11px]">
          <span className="size-[5px] rounded-full bg-vn-mint" /> Jamie{" "}
          <time className="ml-[3px] text-vn-muted">00:08</time>
        </span>
      </div>
      <div className="mx-6 border-t border-vn-stroke pb-6 pt-[17px] [@media(max-width:640px)]:mx-4 [@media(max-width:640px)]:pt-4">
        <div className="flex items-center gap-2 text-[10px] text-vn-secondary [@media(max-width:640px)]:text-[12px]">
          <FileTextIcon className="size-[13px] flex-none" />
          <span className="flex-1">Scope review</span>
        </div>
        <blockquote className="my-3 text-[11px] leading-[1.9] text-vn-muted [@media(max-width:640px)]:text-[13px] [@media(max-width:640px)]:leading-[1.7]">
          “The review needs to cover the revised scope.”
        </blockquote>
        <span className="flex items-center gap-[7px] text-[8px] text-vn-mint [@media(max-width:640px)]:text-[11px]">
          <span className="size-[5px] rounded-full bg-vn-mint" /> Jamie{" "}
          <time className="ml-[3px] text-vn-muted">01:12</time>
        </span>
      </div>
    </motion.figure>
  );
}

function ConversationContextDemo({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.figure
      className="min-w-0 scroll-mt-6 overflow-hidden rounded-[6px] border border-vn-stroke-strong bg-vn-sidebar"
      aria-label="Planned profile enrichment and conversation preparation demo"
      initial="rest"
      whileInView={reduceMotion ? "rest" : "play"}
      viewport={{ once: true, amount: 0.4 }}
    >
      <div className="flex justify-between gap-3 border-b border-vn-stroke px-6 py-4 text-[8px] tracking-[0.06em] text-vn-muted [@media(max-width:640px)]:px-4 [@media(max-width:640px)]:py-3.5 [@media(max-width:640px)]:text-[10px]">
        <span>NEXT CONVERSATION</span>
        <span className="text-vn-mint">PLANNED</span>
      </div>
      <div className="px-6 py-7 [@media(max-width:640px)]:px-4 [@media(max-width:640px)]:py-5">
        <h2 className="text-[21px] tracking-[-0.04em]">Follow-up with Jamie</h2>
        <motion.div
          className="mt-[26px] [@media(max-width:640px)]:mt-5"
          variants={reveal}
          custom={0.6}
        >
          <h3 className="text-[9px] font-normal text-vn-muted [@media(max-width:640px)]:text-[11px]">
            Profile context
          </h3>
          <p className="mt-2 text-[13px] leading-[1.8] text-vn-secondary">
            <strong className="font-medium text-vn-text">Review required</strong> before launch.
          </p>
          <a
            className="mt-2.5 inline-flex items-center gap-2 text-[9px] text-vn-muted [@media(max-width:640px)]:mt-1 [@media(max-width:640px)]:min-h-11 [@media(max-width:640px)]:text-[11px]"
            href="#demo"
          >
            Launch review · 00:08 <ArrowRightIcon className="size-3" aria-hidden="true" />
          </a>
        </motion.div>
        <motion.span
          className="my-[18px] block text-vn-muted [@media(max-width:640px)]:my-2.5"
          aria-hidden="true"
          variants={reveal}
          custom={1}
        >
          ↓
        </motion.span>
        <motion.div
          className="vn-followup-question border-l-2 border-vn-mint bg-vn-page px-4 py-3 [@media(max-width:640px)]:px-3"
          variants={reveal}
          custom={1.35}
        >
          <h3 className="text-[9px] font-normal text-vn-muted [@media(max-width:640px)]:text-[11px]">
            Suggested follow-up
          </h3>
          <p className="mt-2 text-[13px] leading-[1.8] text-vn-secondary">
            Has the review cleared?
          </p>
        </motion.div>
      </div>
    </motion.figure>
  );
}

export function LandingPage({
  message,
  onCheckSignIn,
}: {
  message?: string;
  onCheckSignIn: () => void;
}) {
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInPending, setSignInPending] = useState(false);
  const [replay, setReplay] = useState(0);
  const reduceMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    getServerReducedMotion,
  );
  const signInTrigger = useRef<HTMLButtonElement | null>(null);
  function openSignIn(event: MouseEvent<HTMLButtonElement>) {
    signInTrigger.current = event.currentTarget;
    setSignInOpen(true);
  }
  return (
    <div className="vn-landing overflow-clip bg-vn-page text-vn-text [&_a:hover]:text-vn-text [&_a:focus-visible]:outline [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-[6px] [&_a:focus-visible]:outline-vn-mint motion-reduce:[&_*]:!animate-none motion-reduce:[&_*]:!transition-none motion-reduce:[&_*]:!scroll-auto motion-reduce:[&_*::before]:!animate-none motion-reduce:[&_*::before]:!transition-none motion-reduce:[&_*::before]:!scroll-auto motion-reduce:[&_*::after]:!animate-none motion-reduce:[&_*::after]:!transition-none motion-reduce:[&_*::after]:!scroll-auto">
      <a
        className="absolute left-4 top-2.5 -translate-y-[160%] bg-vn-surface p-2.5 focus:translate-y-0"
        href="#main"
      >
        Skip to content
      </a>
      <header className="mx-auto flex h-[88px] w-[min(1120px,calc(100%-96px))] items-center justify-between border-b border-vn-stroke max-[900px]:w-[calc(100%-48px)] [@media(max-width:640px)]:h-[68px] [@media(max-width:640px)]:w-[calc(100%-32px)]">
        <a href="#" aria-label="VoidNote home">
          <Brand />
        </a>
        <nav className="flex items-center gap-8" aria-label="Main navigation">
          <Button
            variant="outline"
            className="[@media(max-width:640px)]:min-h-11"
            onClick={openSignIn}
          >
            Sign in <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </nav>
      </header>
      <main
        id="main"
        className="mx-auto w-[min(1120px,calc(100%-96px))] max-[900px]:w-[calc(100%-48px)] [@media(max-width:640px)]:w-[calc(100%-32px)]"
      >
        {message && (
          <div
            className="flex flex-wrap items-center justify-center gap-3 pt-6 text-[12px] text-vn-muted"
            role="status"
          >
            <span>{message}</span>
            <Button variant="outline" size="sm" onClick={onCheckSignIn}>
              Retry connection
            </Button>
          </div>
        )}
        <section
          className="pb-11 pt-16 text-center min-[1400px]:pt-[72px] [@media(max-width:640px)]:pb-7 [@media(max-width:640px)]:pt-9"
          aria-labelledby="landing-title"
        >
          <motion.h1
            className="mb-6 mt-[25px] text-[clamp(36px,5.5vw,64px)] font-normal leading-[1.1] tracking-[-0.075em] [@media(max-width:640px)]:mx-auto [@media(max-width:640px)]:mb-5 [@media(max-width:640px)]:mt-0 [@media(max-width:640px)]:max-w-[19ch] [@media(max-width:640px)]:text-balance [@media(max-width:640px)]:text-[clamp(28px,7.5vw,40px)] [@media(max-width:640px)]:leading-[1.18] [@media(max-width:640px)]:tracking-[-0.06em]"
            id="landing-title"
            variants={reveal}
            initial="rest"
            animate={reduceMotion ? "rest" : "play"}
          >
            Every conversation <br className="[@media(max-width:640px)]:hidden" />
            builds{" "}
            <strong className="font-medium text-vn-mint [@media(max-width:640px)]:inline-block">
              reusable context.
            </strong>
          </motion.h1>
          <p className="text-[14px] leading-[1.9] tracking-[-0.025em] text-vn-muted [@media(max-width:640px)]:text-balance [@media(max-width:640px)]:text-[13px] [@media(max-width:640px)]:leading-[1.7]">
            Make more of the conversation.{" "}
            <em className="font-mono-italic text-vn-secondary [@media(max-width:640px)]:block">
              Even the parts you missed.
            </em>
          </p>
          <div className="mt-[30px] flex items-center justify-center gap-[26px] [@media(max-width:640px)]:mt-6 [@media(max-width:640px)]:gap-[18px]">
            <MotionButton
              size="lg"
              className="[@media(max-width:640px)]:min-h-11 [@media(max-width:640px)]:px-[18px]"
              onClick={openSignIn}
              whileHover={reduceMotion ? {} : { y: -2 }}
              whileTap={reduceMotion ? {} : { scale: 0.98 }}
            >
              Get started <ArrowRightIcon data-icon="inline-end" />
            </MotionButton>
          </div>
        </section>
        <div id="demo" className="relative scroll-mt-8">
          <ProductDemo
            replay={replay}
            onReplay={() => setReplay((value) => value + 1)}
            reduceMotion={reduceMotion}
          />
        </div>
        <section
          key={replay}
          className="grid grid-cols-2 gap-6 py-8 [@media(max-width:640px)]:grid-cols-1 [@media(max-width:640px)]:gap-5 [@media(max-width:640px)]:py-5"
          aria-label="Profiles and planned follow-ups"
        >
          <ProfileDemo reduceMotion={reduceMotion} />
          <ConversationContextDemo reduceMotion={reduceMotion} />
        </section>
      </main>
      <footer className="mx-auto flex w-[min(1120px,calc(100%-96px))] items-center justify-between gap-5 border-t border-vn-stroke py-8 max-[900px]:w-[calc(100%-48px)] [@media(max-width:640px)]:w-[calc(100%-32px)] [@media(max-width:640px)]:flex-wrap [@media(max-width:640px)]:gap-4 [@media(max-width:640px)]:py-6">
        <Brand compact />
        <span className="text-[9px] text-vn-muted [@media(max-width:640px)]:text-[10px]">
          © {new Date().getFullYear()} The Null Node
        </span>
      </footer>
      <Dialog
        open={signInOpen}
        onOpenChange={(open) => {
          if (!signInPending) setSignInOpen(open);
        }}
      >
        <DialogContent
          closeDisabled={signInPending}
          className="max-h-[calc(100dvh-32px)] w-[min(460px,calc(100%-32px))] overflow-y-auto motion-reduce:!animate-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            signInTrigger.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">Sign in to VoidNote</DialogTitle>
          <DialogDescription className="sr-only">
            Use Google or an email sign-in link to open your workspace.
          </DialogDescription>
          <SignIn
            onPendingChange={setSignInPending}
            className="w-full border-0 px-0 pb-0 pt-4 [@media(max-width:760px)]:px-0 [@media(max-width:760px)]:pb-0 [@media(max-width:760px)]:pt-4"
            {...(message ? { message } : {})}
          />
          <Button variant="ghost" onClick={onCheckSignIn} disabled={signInPending}>
            Already opened your link? Check sign-in
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
