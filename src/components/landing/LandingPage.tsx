"use client";

import { useRef, useState, type MouseEvent } from "react";
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

function Waveform({ small = false }: { small?: boolean }) {
  const count = small ? 36 : 84;
  return (
    <svg className="vn-demo-wave" viewBox={`0 0 ${count * 7} 64`} fill="none" aria-hidden="true">
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
            style={{ animationDelay: `${index * 23}ms` }}
          />
        );
      })}
    </svg>
  );
}

function ProductDemo() {
  const [replay, setReplay] = useState(0);
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
        <span>YOUR CONVERSATION, KEPT.</span>
        <span className="vn-demo-sample">DEMO</span>
      </div>
      <div className="vn-demo-workspace" key={replay}>
        <aside className="vn-demo-sidebar" aria-hidden="true">
          <span className="vn-demo-sidebar-title">Your notes</span>
          <span className="vn-demo-note is-selected">
            <FileTextIcon /> A little room to think
          </span>
          <span className="vn-demo-note">
            <FileTextIcon /> The next chapter
          </span>
          <span className="vn-demo-note">
            <FileTextIcon /> Friday catch-up
          </span>
          <span className="vn-demo-sidebar-bottom">
            <span className="vn-demo-avatar">J</span> Just you. All here.
          </span>
        </aside>
        <div className="vn-demo-document">
          <div className="vn-demo-document-meta">
            <span>CONVERSATIONS / 001</span>
            <span>
              <CheckIcon /> Saved
            </span>
          </div>
          <h2>A little room to think</h2>
          <p className="vn-demo-date">Today · 2 speakers</p>
          <div className="vn-demo-audio">
            <span className="vn-demo-audio-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="m5 3 8 5-8 5V3Z" />
              </svg>
            </span>
            <Waveform />
            <span>02:34</span>
          </div>
          <div className="vn-demo-transcript">
            <div className="vn-demo-passage vn-demo-passage-one">
              <div className="vn-demo-speaker">
                <span className="vn-speaker-dot" /> Jamie <time>00:08</time>
              </div>
              <p>What if we made a little more room for the things we actually want to work on?</p>
            </div>
            <div className="vn-demo-passage vn-demo-passage-two">
              <div className="vn-demo-speaker">
                <span className="vn-speaker-dot is-second" /> Alex <time>00:16</time>
              </div>
              <p>
                I like that.{" "}
                <span className="vn-demo-highlight">Less rushing to the next thing.</span> More time
                with the idea in front of us.
              </p>
            </div>
            <div className="vn-demo-passage vn-demo-passage-three">
              <div className="vn-demo-speaker">
                <span className="vn-speaker-dot" /> Jamie <time>00:24</time>
              </div>
              <p>Exactly. Let’s start there.</p>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="vn-demo-caption">
        <span>
          <span className="vn-status-dot" /> A conversation becomes a note.
        </span>
        <Button variant="ghost" size="sm" onClick={() => setReplay((value) => value + 1)}>
          <LoopIcon data-icon="inline-start" /> Replay demo
        </Button>
      </figcaption>
    </figure>
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
  const [corrected, setCorrected] = useState(false);
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
          <a href="#how-it-works" className="vn-landing-how-link">
            How it works
          </a>
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
          <p className="vn-landing-eyebrow">
            <span className="vn-status-dot" /> A QUIET SPACE FOR YOUR CONVERSATIONS
          </p>
          <h1 id="landing-title">
            Stay in the
            <br />
            <span>conversation.</span>
          </h1>
          <p className="vn-landing-description">Record it. Come back to every word.</p>
          <div className="vn-landing-hero-actions">
            <Button size="lg" onClick={openSignIn}>
              Get started <ArrowRightIcon data-icon="inline-end" />
            </Button>
            <a href="#demo">
              Take a closer look <span aria-hidden="true">↘</span>
            </a>
          </div>
        </section>
        <div id="demo" className="vn-landing-demo-wrap">
          <ProductDemo />
        </div>
        <section
          id="how-it-works"
          className="vn-landing-features"
          aria-label="From conversation to note"
        >
          <article className="vn-landing-feature">
            <div className="vn-feature-heading">
              <span>01</span>
              <h2>Capture.</h2>
            </div>
            <p>Press record. Or bring your audio.</p>
            <div
              className="vn-feature-visual vn-feature-capture"
              role="img"
              aria-label="Illustration of an audio recording waveform"
            >
              <div className="vn-mini-recording">
                <span className="vn-record-dot" />
                <span>Recording</span>
                <span>00:42</span>
              </div>
              <Waveform small />
              <div className="vn-mini-recording-footer">
                <span>Just let it flow.</span>
                <span className="vn-record-stop" />
              </div>
            </div>
          </article>
          <article className="vn-landing-feature">
            <div className="vn-feature-heading">
              <span>02</span>
              <h2>Follow along.</h2>
            </div>
            <p>Every voice. A place on the page.</p>
            <div
              className="vn-feature-visual vn-feature-speakers"
              role="img"
              aria-label="Illustration of a transcript with separate speakers"
            >
              <div>
                <span className="vn-mini-avatar">J</span>
                <div>
                  <span>
                    Jamie <small>00:08</small>
                  </span>
                  <i />
                  <i />
                </div>
              </div>
              <div>
                <span className="vn-mini-avatar is-second">A</span>
                <div>
                  <span>
                    Alex <small>00:16</small>
                  </span>
                  <i />
                  <i />
                </div>
              </div>
            </div>
          </article>
          <article className="vn-landing-feature">
            <div className="vn-feature-heading">
              <span>03</span>
              <h2>Make it right.</h2>
            </div>
            <p>A different speaker? One small edit.</p>
            <div className="vn-feature-visual vn-feature-correction">
              <span className="vn-correction-label">SAMPLE SPEAKER EDIT</span>
              <span className="vn-correction-quote">“Let’s start there.”</span>
              <div className="vn-correction-action">
                <span aria-live="polite">
                  <PersonIcon /> {corrected ? "Jamie" : "Alex"}
                </span>
                <Button variant="outline" size="sm" onClick={() => setCorrected((value) => !value)}>
                  {corrected ? "Undo" : "Assign to Jamie"}
                  {corrected && <CheckIcon data-icon="inline-end" />}
                </Button>
              </div>
            </div>
          </article>
        </section>
        <section className="vn-landing-closing" aria-label="Get started">
          <p>Good conversations deserve a place.</p>
          <Button variant="outline" onClick={openSignIn}>
            Make room for yours <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </section>
      </main>
      <footer className="vn-landing-footer">
        <Brand />
        <span>A little less lost. A little more kept.</span>
        <span>© {new Date().getFullYear()} VoidNote</span>
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
