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

function Brand() {
  return (
    <span className="vn-landing-brand">
      <svg viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <path
          d="M4 8v12M9 4v20M14 9v10M19 4v20M24 8v12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      VoidNote<span className="vn-brand-period">.</span>
    </span>
  );
}

function Waveform({ reduceMotion }: { reduceMotion: boolean }) {
  const count = 84;
  return (
    <svg className="vn-demo-wave" viewBox={`0 0 ${count * 7} 64`} fill="none" aria-hidden="true">
      <motion.g
        initial={{ scaleY: 1 }}
        whileInView={{ scaleY: reduceMotion ? 1 : [0.35, 1, 0.7, 1] }}
        viewport={{ once: true }}
        transition={{ duration: reduceMotion ? 0 : 1.2, ease: "easeInOut" }}
        style={{ transformOrigin: "center", transformBox: "fill-box" }}
      >
        {Array.from({ length: count }, (_, index) => {
          const height = 6 + Math.abs(Math.sin(index * 1.7) * Math.cos(index * 0.31)) * 48;
          return (
            <rect
              key={index}
              x={index * 7 + 1}
              y={(64 - height) / 2}
              width="2.5"
              height={height}
              rx="1.25"
            />
          );
        })}
      </motion.g>
    </svg>
  );
}

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
      className="vn-product-demo"
      aria-label="Illustrated sample of a conversation transcribed in VoidNote"
    >
      <div className="vn-demo-chrome">
        <div className="vn-window-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <span>RECORDING / TRANSCRIPT</span>
        <span className="vn-demo-sample">DEMO</span>
      </div>
      <div className="vn-demo-workspace" key={replay}>
        <aside className="vn-demo-sidebar" aria-hidden="true">
          <span className="vn-demo-sidebar-title">Recordings</span>
          <span className="vn-demo-note is-selected">
            <FileTextIcon /> Launch review
          </span>
          <span className="vn-demo-note">
            <FileTextIcon /> Scope review
          </span>
          <span className="vn-demo-note">
            <FileTextIcon /> Weekly sync
          </span>
          <span className="vn-demo-sidebar-title vn-demo-profiles-label">Speaker profiles</span>
          <span className="vn-demo-note">
            <PersonIcon /> Jamie
          </span>
          <span className="vn-demo-note">
            <PersonIcon /> Alex
          </span>
          <span className="vn-demo-sidebar-bottom">
            <span className="vn-demo-avatar">J</span> Workspace
          </span>
        </aside>
        <div className="vn-demo-document">
          <div className="vn-demo-document-meta">
            <span>CONVERSATIONS / 001</span>
            <span>
              <CheckIcon /> Saved
            </span>
          </div>
          <h2>Launch review</h2>
          <p className="vn-demo-date">Today · 2 speakers</p>
          <div className="vn-demo-audio">
            <span className="vn-demo-audio-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="m5 3 8 5-8 5V3Z" />
              </svg>
            </span>
            <Waveform reduceMotion={reduceMotion} />
            <span>02:34</span>
          </div>
          <motion.div
            className="vn-demo-transcript"
            initial="rest"
            whileInView={reduceMotion ? "rest" : "play"}
            viewport={{ once: true, amount: 0.4 }}
          >
            <motion.div className="vn-demo-passage" variants={reveal} custom={0.1}>
              <div className="vn-demo-speaker">
                <span className="vn-speaker-dot" /> <a href="#profiles">Jamie ↗</a>{" "}
                <time>00:08</time>
              </div>
              <p>
                We need the <strong>review complete</strong> before launch.
              </p>
            </motion.div>
            <motion.div className="vn-demo-passage" variants={reveal} custom={0.45}>
              <div className="vn-demo-speaker">
                <span className="vn-speaker-dot is-second" /> Alex <time>00:16</time>
              </div>
              <p>
                I’ll send the <span className="vn-demo-highlight">revised scope on Thursday.</span>
              </p>
            </motion.div>
            <motion.div className="vn-demo-passage" variants={reveal} custom={0.8}>
              <div className="vn-demo-speaker">
                <span className="vn-speaker-dot" /> Jamie <time>00:24</time>
              </div>
              <p>Then we can confirm the launch date.</p>
            </motion.div>
          </motion.div>
        </div>
      </div>
      <figcaption className="vn-demo-caption">
        <span>Sample recording</span>
        <Button variant="ghost" size="sm" onClick={onReplay}>
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
      className="vn-profile-demo"
      aria-label="Sample profile showing Jamie's words across two conversations"
      initial="rest"
      whileInView={reduceMotion ? "rest" : "play"}
      viewport={{ once: true, amount: 0.4 }}
    >
      <div className="vn-profile-demo-top">
        <span>SPEAKER PROFILE</span>
        <span>DEMO</span>
      </div>
      <div className="vn-profile-identity">
        <span className="vn-profile-portrait">J</span>
        <div>
          <h2>Jamie</h2>
          <p>2 recordings</p>
        </div>
      </div>
      <div className="vn-profile-appearance">
        <a href="#demo">
          <FileTextIcon />
          <span>Launch review</span>
          <ArrowRightIcon />
        </a>
        <motion.blockquote variants={sourceEmphasis}>
          “We need the <strong>review complete</strong> before launch.”
        </motion.blockquote>
        <span className="vn-profile-source">
          <span className="vn-speaker-dot" /> Jamie <time>00:08</time>
        </span>
      </div>
      <div className="vn-profile-appearance">
        <div className="vn-profile-source-title">
          <FileTextIcon />
          <span>Scope review</span>
        </div>
        <blockquote>“The review needs to cover the revised scope.”</blockquote>
        <span className="vn-profile-source">
          <span className="vn-speaker-dot" /> Jamie <time>01:12</time>
        </span>
      </div>
    </motion.figure>
  );
}

function ConversationContextDemo({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.figure
      className="vn-profile-demo vn-followup-demo"
      aria-label="Planned profile enrichment and conversation preparation demo"
      initial="rest"
      whileInView={reduceMotion ? "rest" : "play"}
      viewport={{ once: true, amount: 0.4 }}
    >
      <div className="vn-profile-demo-top">
        <span>NEXT CONVERSATION</span>
        <span>PLANNED</span>
      </div>
      <div className="vn-followup-content">
        <h2>Follow-up with Jamie</h2>
        <motion.div className="vn-followup-context" variants={reveal} custom={0.6}>
          <h3>Profile context</h3>
          <p>
            <strong>Review required</strong> before launch.
          </p>
          <a href="#demo">
            Launch review · 00:08 <ArrowRightIcon aria-hidden="true" />
          </a>
        </motion.div>
        <motion.span className="vn-followup-arrow" aria-hidden="true" variants={reveal} custom={1}>
          ↓
        </motion.span>
        <motion.div className="vn-followup-question" variants={reveal} custom={1.35}>
          <h3>Suggested follow-up</h3>
          <p>Has the review cleared?</p>
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
    <div className="vn-landing">
      <a className="vn-landing-skip" href="#main">
        Skip to content
      </a>
      <header className="vn-landing-header">
        <a href="#" aria-label="VoidNote home">
          <Brand />
        </a>
        <nav aria-label="Main navigation">
          <Button variant="outline" onClick={openSignIn}>
            Sign in <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </nav>
      </header>
      <main id="main">
        {message && (
          <div className="vn-landing-auth-status" role="status">
            <span>{message}</span>
            <Button variant="outline" size="sm" onClick={onCheckSignIn}>
              Retry connection
            </Button>
          </div>
        )}
        <section className="vn-landing-hero" aria-labelledby="landing-title">
          <motion.h1
            id="landing-title"
            variants={reveal}
            initial="rest"
            animate={reduceMotion ? "rest" : "play"}
          >
            Every conversation <br />
            builds <strong>reusable context.</strong>
          </motion.h1>
          <p className="vn-landing-description">
            Make more of the conversation. <em>Even the parts you missed.</em>
          </p>
          <div className="vn-landing-hero-actions">
            <MotionButton
              size="lg"
              onClick={openSignIn}
              whileHover={reduceMotion ? {} : { y: -2 }}
              whileTap={reduceMotion ? {} : { scale: 0.98 }}
            >
              Get started <ArrowRightIcon data-icon="inline-end" />
            </MotionButton>
          </div>
        </section>
        <div id="demo" className="vn-landing-demo-wrap">
          <ProductDemo
            replay={replay}
            onReplay={() => setReplay((value) => value + 1)}
            reduceMotion={reduceMotion}
          />
        </div>
        <section
          key={replay}
          className="vn-landing-details"
          aria-label="Profiles and planned follow-ups"
        >
          <ProfileDemo reduceMotion={reduceMotion} />
          <ConversationContextDemo reduceMotion={reduceMotion} />
        </section>
      </main>
      <footer className="vn-landing-footer">
        <Brand />
        <span>© {new Date().getFullYear()} The Null Node</span>
      </footer>
      <Dialog open={signInOpen} onOpenChange={setSignInOpen}>
        <DialogContent
          className="vn-landing-signin motion-reduce:!animate-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            signInTrigger.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">Sign in to VoidNote</DialogTitle>
          <DialogDescription className="sr-only">
            Get an email sign-in link to open your workspace.
          </DialogDescription>
          <SignIn {...(message ? { message } : {})} />
          <Button variant="ghost" onClick={onCheckSignIn}>
            Already opened your link? Check sign-in
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
