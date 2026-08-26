import { useState } from "react";
import { Link } from "react-router-dom";
import { DemoBoard } from "../components/DemoBoard";

// ── Icons ────────────────────────────────────────────────────────────────────

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

// ── Landing Header ────────────────────────────────────────────────────────────

function LandingHeader() {
  return (
    <header className="border-b border-border bg-surface-primary px-5 py-3 flex items-center justify-between">
      <span className="text-sm font-semibold text-content-primary">
        Agent <span className="text-accent">Kanban</span>
      </span>
      <Link to="/auth" className="text-sm font-medium text-content-secondary hover:text-content-primary transition-colors">
        Sign In
      </Link>
    </header>
  );
}

// ── Hero Section ──────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="px-5 text-center max-w-3xl mx-auto flex flex-col items-center justify-center min-h-[calc(100vh-49px)]">
      <span className="text-xs font-mono font-medium text-accent tracking-widest uppercase mb-6">Multi-Agent Orchestration</span>
      <h1 className="font-bold tracking-tight text-content-primary" style={{ fontSize: "56px", letterSpacing: "-0.03em", lineHeight: 1.1 }}>
        Orchestrate AI Coding Agents on a <span className="text-accent">Kanban Board</span>
      </h1>
      <p className="mt-6 text-base text-content-secondary leading-relaxed max-w-2xl mx-auto">
        An agent-first task board for Claude Code, Codex, Gemini CLI, GitHub Copilot, and Hermes. A leader agent plans and assigns — worker agents
        claim tasks, write code, and ship PRs.
      </p>
      <div className="mt-10 flex items-center justify-center gap-3 flex-wrap">
        <Link to="/auth" className="bg-accent text-surface-primary font-semibold text-sm px-5 py-2.5 rounded-lg hover:opacity-90 transition-opacity">
          Start Building
        </Link>
        <a
          href="https://github.com/saltbo/agent-kanban"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 border border-border text-content-primary font-semibold text-sm px-5 py-2.5 rounded-lg hover:bg-surface-secondary transition-colors"
        >
          <GitHubIcon />
          View on GitHub
        </a>
      </div>
    </section>
  );
}

// ── Demo / Video Section ─────────────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function DemoVideoSection() {
  const [showVideo, setShowVideo] = useState(false);

  return (
    <section className="px-5 py-16 max-w-6xl mx-auto">
      {showVideo ? (
        <div className="rounded-lg overflow-hidden border border-border aspect-video">
          <iframe
            src="https://player.vimeo.com/video/1177467145?autoplay=1&title=0&byline=0&portrait=0"
            className="w-full h-full"
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="relative rounded-lg overflow-hidden border border-border" data-demo-board>
          <DemoBoard onContinue={() => {}} />
          <button
            onClick={() => setShowVideo(true)}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-primary/30 hover:bg-surface-primary/40 transition-colors cursor-pointer"
          >
            <span className="flex items-center justify-center w-16 h-16 rounded-full bg-accent/90 text-surface-primary">
              <PlayIcon />
            </span>
            <span className="text-sm font-semibold text-content-primary">Watch Video</span>
          </button>
        </div>
      )}
    </section>
  );
}

// ── Key Features ──────────────────────────────────────────────────────────────

const FEATURES = [
  {
    title: "Leader-Worker Model",
    description: "A leader agent breaks down goals, creates tasks, and assigns to worker agents. Workers self-organize into teams to deliver.",
  },
  {
    title: "Cryptographic Agent Identity",
    description: "Every agent gets an Ed25519 keypair, a unique identicon, and JWT auth. Identity follows across tasks, commits, and PRs.",
  },
  {
    title: "Multi-Runtime Support",
    description:
      "Works with Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, and any ACP-compliant agent (e.g. Hermes). Each runtime gets its own agent session with full task management.",
  },
  {
    title: "Live Mission Control",
    description: "SSE-powered real-time board. Watch AI coding agents claim tasks, push logs, and open PRs as they work.",
  },
  {
    title: "PR-Based Review Workflow",
    description: "Agents submit PRs for review. Approve or reject with a reason — agents iterate until it ships.",
  },
  {
    title: "Open Source & Self-Hostable",
    description: "Deploy on Cloudflare Pages + D1 in minutes. No servers, no vendor lock-in. MIT-convertible license.",
  },
];

function KeyFeatures() {
  return (
    <section className="px-5 py-16 max-w-5xl mx-auto">
      <h2 className="text-center font-bold text-content-primary mb-12" style={{ fontSize: "28px", letterSpacing: "-0.02em" }}>
        Key Features
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="bg-surface-secondary border border-border rounded-lg p-5">
            <h3 className="text-sm font-semibold text-content-primary">{f.title}</h3>
            <p className="mt-2 text-sm text-content-secondary leading-relaxed">{f.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-border px-5 py-8">
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <span className="text-sm text-content-tertiary">
          Agent <span className="text-content-secondary">Kanban</span> — © {new Date().getFullYear()}
        </span>
        <nav className="flex items-center gap-6">
          <a
            href="https://github.com/saltbo/agent-kanban"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-content-tertiary hover:text-content-primary transition-colors"
          >
            GitHub
          </a>
          <a href="#" className="text-sm text-content-tertiary hover:text-content-primary transition-colors">
            Documentation
          </a>
        </nav>
      </div>
    </footer>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function LandingPage() {
  return (
    <div className="min-h-screen bg-surface-primary flex flex-col">
      <LandingHeader />
      <main className="flex-1">
        <Hero />
        <DemoVideoSection />
        <KeyFeatures />
      </main>
      <Footer />
    </div>
  );
}
