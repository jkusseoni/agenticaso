'use client';
import React, { useState, useEffect, useRef } from "react";
import { SignInButton, SignUpButton, UserButton, useAuth, useUser } from "@clerk/nextjs";

/*
  Agenticaso — launch-ready single-page app (landing + live agent checker)
  ------------------------------------------------------------------------
  ASO = Agentic Search Optimization. Positioning: everyone optimizes to be the
  ANSWER; Agenticaso makes you the PURCHASE — found, recommended and bought by
  the AI agents your customers now shop with.

  Deploy this to Vercel today and point Agenticaso.com at it. The scan is
  simulated (a browser can't fetch cross-origin sites); wire real checks in
  Next.js API routes behind the same UI:
    Found        -> robots.txt (GPTBot/ClaudeBot/PerplexityBot allowed?), feed, sitemap
    Understood   -> schema.org Product/Offer, llms.txt, clean (non-JS-locked) HTML
    Recommended  -> reviews/ratings, entity clarity, comparison-ready copy
    Bought       -> ACP/UCP agent-checkout readiness, live price/stock
*/

const C = {
  paper: "#F5F6FB", ink: "#15152B", muted: "#5B5B78",
  violet: "#5A47F5", violetDeep: "#3A2AC0", teal: "#12B886",
  coral: "#FF6A5A", amber: "#F5A623", card: "#FFFFFF",
  border: "#E7E8F3", dark: "#111024",
};
const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif";
const BODY = "'Inter', system-ui, sans-serif";
const CHATGPT_PLUGIN_URL = "https://chatgpt.com/plugins/plugin_asdk_app_6aa78c2ecb7c8191b1830cbf6cadbb16";

const LADDER = [
  { k: "SEO", d: "Rank in blue links", old: true },
  { k: "GEO", d: "Get cited in AI answers", old: true },
  { k: "AEO", d: "Be the answer", old: true },
  { k: "ASO", d: "Be the purchase", old: false },
];
const STATS = [
  { n: "393%", l: "YoY growth in AI traffic to retail sites (Adobe, Q1 2026)" },
  { n: "50M", l: "shopping queries a day now run through ChatGPT" },
  { n: "4.4×", l: "higher conversion from AI-referred shoppers" },
  { n: "$15T", l: "of spend AI agents will intermediate by 2028 (Gartner)" },
];
const PILLARS = [
  { key: "discover", i: "🔍", t: "Found", q: "Can agents crawl & index you?", d: "Agent crawlers can reach you and your product feed is live — so agents can see you at all." },
  { key: "understand", i: "🧩", t: "Understood", q: "Do agents understand your products?", d: "Structured data, schema and llms.txt let agents read your prices, stock and specs instead of guessing." },
  { key: "recommend", i: "⭐", t: "Recommended", q: "Will an agent pick you over a rival?", d: "Clear reviews, specs and authority make an agent choose you over the store it was also considering." },
  { key: "transact", i: "🛒", t: "Bought", q: "Can an agent actually check out?", d: "Agent-ready checkout (ACP / UCP) so an agent completes the sale, not just a mention." },
];
const STEPS = [
  { n: "01", t: "Audit", d: "We send real AI agents at your store and measure how often you're found, recommended, and able to be bought — across ChatGPT, Perplexity and Gemini." },
  { n: "02", t: "Optimize", d: "We fix what's blocking agents: feeds, schema, llms.txt, reviews and agent-checkout readiness — copy-ready or auto-applied." },
  { n: "03", t: "Track", d: "We watch your agent share-of-voice weekly and alert you the moment a competitor overtakes you inside an AI answer." },
];
const SCAN_STEPS = [
  "Sending an AI agent at your store…",
  "Reading your products the way ChatGPT does…",
  "Asking an agent to recommend you vs rivals…",
  "Trying to complete a checkout as an agent…",
];

function scoreColor(s){return s>=70?C.teal:s>=45?C.amber:C.coral;}
function fixLine(key){return{
  discover:"Allow AI agent crawlers (GPTBot, ClaudeBot, PerplexityBot) and publish a product feed so agents can see your catalog.",
  understand:"Add Product & Offer schema and an llms.txt so agents read your prices, stock and specs instead of guessing.",
  recommend:"Surface reviews and comparison-ready specs so an agent confidently picks you over rivals.",
  transact:"Enable agent checkout (ACP/UCP) so an agent can complete the purchase, not just recommend you.",
}[key];}

export default function Agenticaso() {
  const [view, setView] = useState("landing"); // landing | scanning | report
  const [url, setUrl] = useState("");
  const [step, setStep] = useState(0);
  const [report, setReport] = useState(null);
  const [reduce, setReduce] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);
  const timers = useRef([]);

  useEffect(() => { setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches); }, []);

  const run = async () => {
    if (!url.trim()) { focusInput(); return; }
    timers.current.forEach(clearTimeout);
    setErr(null); setView("scanning"); setStep(0);
    window.scrollTo({ top: 0, behavior: "smooth" });
    const per = reduce ? 250 : 850;
    SCAN_STEPS.forEach((_, i) => timers.current.push(setTimeout(() => setStep(i), i * per)));
    const minWait = new Promise((r) => setTimeout(r, reduce ? 500 : SCAN_STEPS.length * per));
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      await minWait;
      if (!res.ok || data.error) { setErr(data.error || "Couldn't scan that site."); setView("error"); return; }
      setReport(data); setView("report");
    } catch (e) {
      await minWait;
      setErr("We couldn't reach that site. Check the URL and try again.");
      setView("error");
    }
  };
  const focusInput = () => { window.scrollTo({ top: 0, behavior: "smooth" }); setTimeout(() => inputRef.current?.focus(), 300); };
  const reset = () => { setView("landing"); setReport(null); setStep(0); };

  return (
    <div style={{ background: C.paper, color: C.ink, fontFamily: BODY, overflowX: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; }
        html { scroll-behavior: smooth; }
        .wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
        .btn:focus-visible, a:focus-visible, input:focus-visible { outline: 3px solid ${C.violet}; outline-offset: 3px; border-radius: 8px; }
        .hero-grid { display: grid; grid-template-columns: 1.02fr .98fr; gap: 44px; align-items: center; }
        .stats-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 20px; }
        .pill-grid, .rep-pill { display: grid; grid-template-columns: repeat(4,1fr); gap: 14px; }
        .rep-pill { grid-template-columns: 1fr 1fr; }
        .step-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 20px; }
        .ladder { display: flex; align-items: stretch; gap: 10px; }
        @keyframes rise { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes glow { 0%,100%{box-shadow:0 0 0 0 rgba(90,71,245,0)} 50%{box-shadow:0 0 0 6px rgba(90,71,245,.12)} }
        @keyframes check { from{stroke-dashoffset:24} to{stroke-dashoffset:0} }
        @keyframes beam { 0%{transform:translateY(-100%)} 100%{transform:translateY(400%)} }
        @keyframes dash { to { stroke-dashoffset: var(--off); } }
        .rise { animation: rise .6s ease both; }
        @media (max-width: 860px){
          .hero-grid{grid-template-columns:1fr;gap:30px}
          .stats-grid{grid-template-columns:repeat(2,1fr)}
          .pill-grid,.rep-pill{grid-template-columns:1fr 1fr}
          .step-grid{grid-template-columns:1fr}
          .ladder{flex-wrap:wrap}
          .nav-links{display:none!important}
          .h1{font-size:38px!important}
          .score-row{grid-template-columns:1fr!important;text-align:center}
        }
        @media (prefers-reduced-motion: reduce){ .rise{animation:none} }
      `}</style>

      <Nav onCTA={focusInput} />

      {view === "landing" && (
        <>
          <Hero url={url} setUrl={setUrl} run={run} inputRef={inputRef} />
          <Ladder />
          <Stats />
          <Pillars />
          <Steps />
          <Proof />
          <FinalCTA onCTA={focusInput} />
        </>
      )}
      {view === "scanning" && <Scanning step={step} clean={report?.clean} />}
      {view === "report" && report && <Report report={report} reset={reset} />}
      {view === "error" && (
        <section className="wrap" style={{ padding: "80px 24px", textAlign: "center", minHeight: "50vh" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🤔</div>
          <h2 style={{ fontFamily: "'Bricolage Grotesque',sans-serif", fontWeight: 800, fontSize: 26, marginBottom: 10 }}>Couldn't scan that</h2>
          <p style={{ color: "#5B5B78", maxWidth: 420, margin: "0 auto 22px" }}>{err}</p>
          <button onClick={reset} className="btn" style={{ padding: "11px 18px", borderRadius: 11, border: "1.5px solid #E7E8F3", background: "#fff", cursor: "pointer", fontWeight: 600 }}>← Try another store</button>
        </section>
      )}

      <Footer />
    </div>
  );
}

function Logo() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`, display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontFamily: DISPLAY, fontSize: 17 }}>a</div>
      <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 19, letterSpacing: -0.3 }}>Agenticaso</span>
    </div>
  );
}
function Nav({ onCTA }) {
  const { isSignedIn } = useAuth();
  const linkBtn = { fontSize: 14.5, color: C.ink, background: "none", border: "none", cursor: "pointer", fontFamily: BODY, padding: 0 };
  return (
    <nav style={{ borderBottom: `1px solid ${C.border}`, background: "rgba(245,246,251,.85)", backdropFilter: "blur(8px)", position: "sticky", top: 0, zIndex: 50 }}>
      <div className="wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 66 }}>
        <Logo />
        <div className="nav-links" style={{ display: "flex", alignItems: "center", gap: 26, fontSize: 14.5, color: C.muted }}>
          <a href="/pricing" style={{ color: C.muted, textDecoration: "none" }}>Pricing</a>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {isSignedIn ? (
            <UserButton />
          ) : (
            <>
              <SignInButton mode="modal">
                <button type="button" style={linkBtn}>Login</button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button type="button" style={linkBtn}>Sign up</button>
              </SignUpButton>
            </>
          )}
          <button className="btn" onClick={onCTA} style={btn(true)}>Free agent report</button>
        </div>
      </div>
    </nav>
  );
}

function Hero({ url, setUrl, run, inputRef }) {
  return (
    <header className="wrap" style={{ padding: "64px 24px 56px" }}>
      <div className="hero-grid">
        <div className="rise">
          <Chip>The next level after AEO</Chip>
          <h1 className="h1" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 50, lineHeight: 1.03, letterSpacing: -1.5, margin: "20px 0 16px" }}>
            Everyone optimizes to be the answer.<br />
            <span style={{ background: `linear-gradient(115deg,${C.violet},${C.teal})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>We make you the purchase.</span>
          </h1>
          <p style={{ fontSize: 16.5, color: C.muted, lineHeight: 1.55, maxWidth: 460, marginBottom: 22 }}>
            Your customers now shop through AI agents. Agenticaso makes sure those agents find you, recommend you over rivals, and can actually complete the sale.
          </p>
          <div style={{ display: "flex", gap: 10, maxWidth: 470, marginBottom: 12 }}>
            <input ref={inputRef} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} placeholder="yourstore.com" aria-label="Your store URL"
              style={{ flex: 1, padding: "13px 16px", borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, fontFamily: BODY, background: "#fff", color: C.ink }} />
            <button className="btn" onClick={run} style={{ ...btn(true), whiteSpace: "nowrap", padding: "13px 20px" }}>Run agent check</button>
          </div>
          <div style={{ fontSize: 12.5, color: C.muted }}>Free · checks 4 things agents care about · ~15 seconds</div>
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 7 }}>
              Agenticaso is now available in ChatGPT
            </div>
            <a
              href={CHATGPT_PLUGIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: C.violetDeep,
                fontSize: 14,
                fontWeight: 700,
                textDecoration: "none",
                padding: "8px 0"
              }}
            >
              Scan Free in ChatGPT ↗
            </a>
          </div>
        </div>
        <AgentActionCard />
      </div>
    </header>
  );
}

function AgentActionCard() {
  const [bought, setBought] = useState(false);
  useEffect(() => { const t = setTimeout(() => setBought(true), 1400); return () => clearTimeout(t); }, []);
  return (
    <div className="rise" style={{ background: C.dark, borderRadius: 22, padding: 24, color: "#EDEDF6", boxShadow: "0 30px 70px -40px rgba(58,42,192,.8)", animation: "rise .6s ease both, glow 3.5s ease-in-out infinite 1s" }}>
      <div style={{ fontSize: 11, letterSpacing: 1, color: "#8A8AB0", fontFamily: "ui-monospace, monospace", marginBottom: 14 }}>SHOPPER → AI AGENT</div>
      <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 16, lineHeight: 1.4 }}>"Find me the best cold-brew maker under ₹2000 and order it."</div>
      <div style={{ background: "#1B1A38", borderRadius: 14, padding: 16, fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
        Comparing 6 stores… <span style={{ color: C.teal }}>BrewCo</span> has clear specs, 1,200 reviews and an agent-ready checkout.
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
          <span style={{ display: "inline-flex", width: 20, height: 20, borderRadius: 6, background: bought ? C.teal : "#2C2B4E", alignItems: "center", justifyContent: "center", transition: "background .4s" }}>
            {bought && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" strokeDasharray="24" style={{ animation: "check .5s ease both" }} /></svg>}
          </span>
          <span style={{ color: bought ? C.teal : "#8A8AB0" }}>{bought ? "Order placed with BrewCo" : "Placing order…"}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {["472 AGENT PICKS", "₹0 → ₹6.1L / MO", "9.1× AGENT REVENUE"].map((t) => <span key={t} style={{ fontSize: 10.5, fontFamily: "ui-monospace, monospace", color: "#B9B9DD", border: "1px solid #33325A", borderRadius: 7, padding: "5px 9px" }}>{t}</span>)}
      </div>
      <div style={{ fontSize: 10, color: "#6A6A92", fontFamily: "ui-monospace, monospace", marginTop: 14 }}>AGENT ACTION CARD · SAMPLE</div>
    </div>
  );
}

function Scanning({ step, clean }) {
  return (
    <section className="wrap" style={{ padding: "70px 24px", textAlign: "center", minHeight: "60vh" }}>
      <div style={{ position: "relative", width: 130, height: 130, margin: "0 auto 28px", borderRadius: 24, overflow: "hidden", border: `1px solid ${C.border}`, background: "#fff" }}>
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, transparent, ${C.violet}22, transparent)`, height: "40%", animation: "beam 1.4s linear infinite" }} />
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 40 }}>🤖</div>
      </div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Scanning {clean}</div>
      <h2 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 24, letterSpacing: -0.5, margin: "0 auto", maxWidth: 460, minHeight: 60 }}>{SCAN_STEPS[step]}</h2>
      <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 16 }}>
        {SCAN_STEPS.map((_, i) => <div key={i} style={{ width: 34, height: 5, borderRadius: 3, background: i <= step ? C.violet : C.border, transition: "background .3s" }} />)}
      </div>
    </section>
  );
}

function Report({ report, reset }) {
  const { total, gap, revenue, findings, verdict, clean } = report;
  return (
    <section className="wrap rise" style={{ padding: "40px 24px 20px" }}>
      <div className="score-row" style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 28, alignItems: "center", background: "#fff", border: `1px solid ${C.border}`, borderRadius: 20, padding: 24, marginBottom: 20 }}>
        <ScoreRing score={total} />
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: 0.4, marginBottom: 6 }}>AGENT-READINESS · {clean}</div>
          <p style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 20, lineHeight: 1.3, margin: "0 0 14px", letterSpacing: -0.3 }}>{verdict}</p>
          <div style={{ display: "flex", gap: 22, justifyContent: "center", flexWrap: "wrap" }}>
            <Stat label="Behind top competitor" value={`−${gap}%`} color={C.coral} />
            <Stat label="Monthly revenue at risk" value={`₹${revenue}K`} color={C.violetDeep} />
          </div>
        </div>
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: 0.4, margin: "4px 2px 12px" }}>FOUND → UNDERSTOOD → RECOMMENDED → BOUGHT</div>
      <div className="rep-pill" style={{ marginBottom: 20 }}>
        {findings.map((f, i) => (
          <div key={f.key} className="rise" style={{ animationDelay: `${i * 70}ms`, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}><span style={{ fontSize: 18 }}>{f.i}</span><span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 16 }}>{f.t}</span></div>
              <span style={{ fontSize: 13, fontWeight: 700, color: scoreColor(f.score), background: scoreColor(f.score) + "1A", padding: "3px 9px", borderRadius: 999 }}>{f.score}</span>
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 8 }}>{f.q}</div>
            <div style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 13.5, lineHeight: 1.4 }}>
              <span style={{ color: f.ok ? C.teal : C.coral, fontWeight: 800 }}>{f.ok ? "✓" : "!"}</span><span>{f.note}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ background: `linear-gradient(135deg,${C.violetDeep},${C.violet})`, borderRadius: 20, padding: 26, color: "#fff", marginBottom: 18 }}>
        <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 22, letterSpacing: -0.4, marginBottom: 14 }}>Your top fixes</div>
        {findings.filter((f) => !f.ok).slice(0, 3).map((f, i) => (
          <div key={f.key} style={{ display: "flex", gap: 12, padding: "11px 0", borderTop: i ? "1px solid rgba(255,255,255,.15)" : "none" }}>
            <span style={{ fontFamily: DISPLAY, fontWeight: 800, opacity: 0.5 }}>{i + 1}</span><span style={{ fontSize: 14.5, lineHeight: 1.4 }}>{fixLine(f.key)}</span>
          </div>
        ))}
        {findings.every((f) => f.ok) && <div style={{ fontSize: 14.5 }}>You're agent-ready. Keep your feed and reviews fresh to stay ahead.</div>}
        <button className="btn" style={{ marginTop: 18, padding: "12px 20px", borderRadius: 11, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14.5, color: C.violetDeep, background: "#fff" }}>Fix these automatically →</button>
      </div>

      <AIVisibility report={report} />

      <div style={{ marginBottom: 18 }}><EmailCapture source="report" report={report} /></div>
      <button onClick={reset} className="btn" style={{ ...btn(false), marginBottom: 10 }}>← Check another store</button>
    </section>
  );
}

function Ladder() {
  return (
    <section className="wrap" style={{ padding: "22px 24px 18px" }}>
      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 20, padding: 24 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.muted, letterSpacing: 0.4, marginBottom: 16, textAlign: "center" }}>SEARCH KEEPS EVOLVING. MOST BRANDS ARE STILL STUCK AT STEP 3.</div>
        <div className="ladder">
          {LADDER.map((s, i) => (
            <React.Fragment key={s.k}>
              <div style={{ flex: 1, minWidth: 130, borderRadius: 14, padding: "16px 14px", textAlign: "center", background: s.old ? "#F3F3FA" : `linear-gradient(135deg,${C.violet},${C.violetDeep})`, border: s.old ? `1px solid ${C.border}` : "none", color: s.old ? C.ink : "#fff" }}>
                <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 22, letterSpacing: -0.5 }}>{s.k}</div>
                <div style={{ fontSize: 12.5, marginTop: 4, color: s.old ? C.muted : "rgba(255,255,255,.85)" }}>{s.d}</div>
                {!s.old && <div style={{ fontSize: 10.5, fontWeight: 700, marginTop: 8, letterSpacing: 0.5 }}>← YOU ARE HERE</div>}
              </div>
              {i < LADDER.length - 1 && <div style={{ display: "flex", alignItems: "center", color: C.muted, fontSize: 18 }}>→</div>}
            </React.Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
function Stats() {
  return (
    <section className="wrap" style={{ padding: "42px 24px" }}>
      <div className="stats-grid">
        {STATS.map((s) => (
          <div key={s.n} style={{ textAlign: "center", padding: "8px 6px" }}>
            <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 38, letterSpacing: -1, color: C.violetDeep, lineHeight: 1 }}>{s.n}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 8, lineHeight: 1.4 }}>{s.l}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
function Pillars() {
  return (
    <section className="wrap" style={{ padding: "42px 24px" }}>
      <SectionHead eyebrow="THE 4 THINGS AGENTS CARE ABOUT" title="Found → Understood → Recommended → Bought" sub="An agent must clear all four before it buys from you. We score each and close the gaps." />
      <div className="pill-grid">
        {PILLARS.map((p, i) => (
          <div key={p.t} className="rise" style={{ animationDelay: `${i * 70}ms`, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16, padding: 20 }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>{p.i}</div>
            <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 8 }}>{p.t}</div>
            <div style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.5 }}>{p.d}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
function Steps() {
  return (
    <section className="wrap" style={{ padding: "42px 24px" }}>
      <SectionHead eyebrow="HOW AGENTICASO WORKS" title="Audit. Optimize. Track." sub="One system to win the agent — and keep winning it." />
      <div className="step-grid">
        {STEPS.map((s) => (
          <div key={s.n} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16, padding: 24 }}>
            <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 30, color: C.violet, letterSpacing: -1, marginBottom: 10 }}>{s.n}</div>
            <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 20, marginBottom: 8 }}>{s.t}</div>
            <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.55 }}>{s.d}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
function Proof() {
  return (
    <section className="wrap" style={{ padding: "42px 24px" }}>
      <div style={{ background: `linear-gradient(135deg,${C.dark},#211F45)`, borderRadius: 24, padding: "42px 40px", color: "#fff", textAlign: "center" }}>
        <div style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 25, lineHeight: 1.4, maxWidth: 720, margin: "0 auto 18px", letterSpacing: -0.4 }}>"We were invisible inside ChatGPT. Within two months Agenticaso had agents recommending us by name — and completing checkouts."</div>
        <div style={{ fontSize: 13, color: "#B9B9DD" }}>Placeholder testimonial — replace with a real customer quote before launch</div>
      </div>
    </section>
  );
}
function FinalCTA({ onCTA }) {
  return (
    <section className="wrap" style={{ padding: "34px 24px 56px" }}>
      <div style={{ background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`, borderRadius: 24, padding: "46px 40px", textAlign: "center", color: "#fff" }}>
        <h2 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 32, letterSpacing: -0.8, marginBottom: 12 }}>See what agents say about your store</h2>
        <p style={{ fontSize: 16, color: "rgba(255,255,255,.85)", maxWidth: 470, margin: "0 auto 24px", lineHeight: 1.5 }}>Free agent-readiness report in minutes — your score, competitor gaps, and the fixes that win you the sale.</p>
        <button className="btn" onClick={onCTA} style={{ ...btn(false), background: "#fff", color: C.violetDeep, border: "none" }}>Run your free report</button>
        <div style={{ maxWidth: 460, margin: "20px auto 0" }}><EmailCapture source="landing" report={null} /></div>
      </div>
    </section>
  );
}
function Footer() {
  return (
    <footer style={{ borderTop: `1px solid ${C.border}`, background: "#fff" }}>
      <div className="wrap" style={{ padding: "26px 24px", display: "flex", flexWrap: "wrap", gap: 14, justifyContent: "space-between", alignItems: "center" }}>
        <Logo />
        <div style={{ fontSize: 12, color: C.muted, maxWidth: 560, lineHeight: 1.5 }}>Agenticaso · ASO = Agentic Search Optimization. Stats: Adobe, OpenAI, Gartner. Scan is a prototype — wire real checks in your backend.</div>
      </div>
    </footer>
  );
}

/* shared bits */
function AIVisibility({ report }) {
  const { isSignedIn, user } = useUser();
  const isPaid = user?.publicMetadata?.paid === true;

  const [status, setStatus] = React.useState("idle"); // idle | running | done | error
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState("");
  const [tick, setTick] = React.useState(0);

  const V = { violet: "#5A47F5", violetDeep: "#3A2AC0", teal: "#0FB88E", amber: "#F5A623", coral: "#FF6A5A", ink: "#15152B", muted: "#5B5B78", border: "#E7E8F3", dark: "#111024" };
  const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif";
  const sovColor = (s) => (s >= 60 ? V.teal : s >= 25 ? V.amber : V.coral);

  React.useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => setTick((t) => t + 1), 2600);
    return () => clearInterval(id);
  }, [status]);

  const steps = [
    "Reading your store to understand what you sell…",
    "Writing 5 buyer questions a real shopper would ask…",
    "Asking Perplexity (live web search)…",
    "Asking ChatGPT (what it already knows)…",
    "Measuring how often you're recommended…",
  ];

  const run = async () => {
    setStatus("running"); setErr(""); setTick(0);
    try {
      const res = await fetch("/api/visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: report?.clean }),
      });
      const d = await res.json();
      if (!res.ok || d.error) { setErr(d.error || "Check failed."); setStatus("error"); return; }
      setData(d); setStatus("done");
    } catch { setErr("Something went wrong. Try again."); setStatus("error"); }
  };

  const shell = { borderRadius: 20, padding: 26, marginBottom: 18, border: `1px solid ${V.border}` };

  // ---------- LOCKED (not signed in / not paid / idle) ----------
  if (status === "idle" || status === "error") {
    return (
      <div style={{ ...shell, background: `linear-gradient(135deg, ${V.dark}, #211F45)`, color: "#fff", border: "none" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11.5, fontWeight: 600, letterSpacing: 0.5, background: "rgba(255,255,255,.12)", padding: "5px 11px", borderRadius: 999, marginBottom: 14 }}>
          🔒 PRO · AI VISIBILITY
        </div>
        <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 24, letterSpacing: -0.5, marginBottom: 8, lineHeight: 1.2 }}>
          Do AI assistants actually recommend you?
        </div>
        <p style={{ fontSize: 14.5, color: "rgba(255,255,255,.8)", lineHeight: 1.5, maxWidth: 520, marginBottom: 18 }}>
          We ask ChatGPT and Perplexity 5 real buyer questions in your category and measure how often <b>{report?.clean}</b> gets recommended vs your competitors. This is the number that decides whether agents send you sales.
        </p>

        {!isSignedIn ? (
          <SignInButton mode="modal">
            <button style={ctaBtn(V)}>Sign in to unlock →</button>
          </SignInButton>
        ) : !isPaid ? (
          <a href="/pricing" style={{ ...ctaBtn(V), display: "inline-block", textDecoration: "none" }}>Upgrade to Pro — ₹499/mo →</a>
        ) : (
          <button onClick={run} style={ctaBtn(V)}>Run AI visibility check →</button>
        )}

        {err && <div style={{ color: "#FFB4AC", fontSize: 13, marginTop: 10 }}>{err}</div>}
      </div>
    );
  }

  // ---------- RUNNING ----------
  if (status === "running") {
    return (
      <div style={{ ...shell, background: "#fff", textAlign: "center" }}>
        <div style={{ fontSize: 34, marginBottom: 12 }}>🤖</div>
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Checking your AI visibility…</div>
        <div style={{ fontSize: 14, color: V.muted, minHeight: 22 }}>{steps[tick % steps.length]}</div>
        <div style={{ fontSize: 12, color: V.muted, marginTop: 14, opacity: 0.7 }}>This takes ~20–30 seconds — we're querying real AI engines.</div>
      </div>
    );
  }

  // ---------- DONE ----------
  const d = data;
  const bar = (label, val, sub) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
        <span style={{ color: V.ink, fontWeight: 500 }}>{label}</span>
        <span style={{ fontWeight: 700, color: sovColor(val) }}>{val}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 5, background: V.border, overflow: "hidden" }}>
        <div style={{ width: `${val}%`, height: "100%", background: sovColor(val), borderRadius: 5, transition: "width .8s ease" }} />
      </div>
      {sub && <div style={{ fontSize: 11.5, color: V.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ ...shell, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: V.violet, letterSpacing: 0.5 }}>AI VISIBILITY · {d.category || "your category"}</div>
          <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 22, letterSpacing: -0.4 }}>{d.brand}</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 38, lineHeight: 1, color: sovColor(d.overall) }}>{d.overall}<span style={{ fontSize: 18, color: V.muted }}>%</span></div>
          <div style={{ fontSize: 11, color: V.muted }}>AI share of voice</div>
        </div>
      </div>
      <p style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 16, lineHeight: 1.35, letterSpacing: -0.2, marginBottom: 18 }}>{d.verdict}</p>
      {bar("In live AI search (Perplexity)", d.webSoV, "What agents recommend when they search the web right now")}
      {bar("In AI memory (ChatGPT)", d.memSoV, "What the model recommends from what it already knows")}
      <div style={{ fontSize: 12, fontWeight: 600, color: V.muted, letterSpacing: 0.4, margin: "18px 0 10px" }}>THE {d.queriesRun} BUYER QUESTIONS WE ASKED</div>
      <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
        {(d.perQuery || []).map((q, i) => {
          const hit = q.webMentioned || q.memMentioned;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: hit ? "#EAFBF4" : "#FFF3F1", border: `1px solid ${hit ? "#CFF3E6" : "#FFD9D3"}`, borderRadius: 11, padding: "10px 13px" }}>
              <span style={{ fontSize: 13.5, color: V.ink }}>"{q.query}"</span>
              <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", color: hit ? V.teal : V.coral }}>{hit ? "✓ mentioned" : "✕ skipped"}</span>
            </div>
          );
        })}
      </div>
      {d.topCompetitors && d.topCompetitors.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: V.muted, letterSpacing: 0.4, marginBottom: 8 }}>AI RECOMMENDED THESE INSTEAD</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {d.topCompetitors.map((c) => (
              <span key={c.name} style={{ fontSize: 13, fontWeight: 500, background: "#F3F3FA", border: `1px solid ${V.border}`, borderRadius: 999, padding: "6px 12px", color: V.ink }}>
                {c.name} <span style={{ color: V.muted, fontSize: 11 }}>×{c.hits}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      <button onClick={() => { setStatus("idle"); setData(null); }} style={{ marginTop: 18, background: "none", border: `1.5px solid ${V.border}`, borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontWeight: 600, fontSize: 13.5, color: V.ink }}>
        Run again
      </button>
    </div>
  );
}

function ctaBtn(V) {
  return { padding: "12px 20px", borderRadius: 11, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14.5, color: V.violetDeep, background: "#fff" };
}
function EmailCapture({ source, report }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle");
  const submit = async () => {
    if (!email.trim()) return;
    setState("saving");
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, url: report?.clean || null, score: report?.total ?? null, source }),
      });
      const data = await res.json();
      setState(res.ok && data.ok ? "done" : "error");
    } catch { setState("error"); }
  };
  if (state === "done") {
    return (
      <div style={{ background: "#EAFBF4", border: "1px solid #CFF3E6", borderRadius: 16, padding: 20, textAlign: "center", color: "#0FB88E", fontWeight: 600 }}>
        ✓ Done — we'll email your full report and weekly agent-tracking.
      </div>
    );
  }
  return (
    <div style={{ background: "#fff", border: "1px solid #E7E8F3", borderRadius: 16, padding: 20 }}>
      <div style={{ fontFamily: "'Bricolage Grotesque',sans-serif", fontWeight: 700, fontSize: 17, marginBottom: 10 }}>📧 Get your full report + weekly agent-tracking</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="you@email.com" style={{ flex: 1, minWidth: 200, padding: "12px 14px", borderRadius: 11, border: "1.5px solid #E7E8F3", fontSize: 15 }} />
        <button onClick={submit} disabled={state === "saving"} style={{ padding: "12px 20px", borderRadius: 11, border: "none", cursor: "pointer", fontWeight: 600, color: "#fff", background: "linear-gradient(135deg,#5A47F5,#3A2AC0)" }}>{state === "saving" ? "…" : "Send it"}</button>
      </div>
      {state === "error" && <div style={{ color: "#FF6A5A", fontSize: 13, marginTop: 8 }}>Couldn't save — check the email and retry.</div>}
    </div>
  );
}
function Chip({ children }) { return <span style={{ display: "inline-block", fontSize: 12.5, fontWeight: 600, color: C.violetDeep, background: "#ECEAFE", padding: "6px 13px", borderRadius: 999 }}>{children}</span>; }
function SectionHead({ eyebrow, title, sub }) {
  return (
    <div style={{ textAlign: "center", marginBottom: 26, maxWidth: 640, marginLeft: "auto", marginRight: "auto" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.violet, letterSpacing: 0.6, marginBottom: 10 }}>{eyebrow}</div>
      <h2 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 30, letterSpacing: -0.8, marginBottom: 10 }}>{title}</h2>
      <p style={{ fontSize: 15, color: C.muted, lineHeight: 1.5 }}>{sub}</p>
    </div>
  );
}
function Stat({ label, value, color }) {
  return (<div><div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 26, color, letterSpacing: -0.5 }}>{value}</div><div style={{ fontSize: 11.5, color: C.muted }}>{label}</div></div>);
}
function ScoreRing({ score }) {
  const r = 62, circ = 2 * Math.PI * r, off = circ - (score / 100) * circ, col = scoreColor(score);
  return (
    <div style={{ position: "relative", width: 160, height: 160, margin: "0 auto" }}>
      <svg width="160" height="160" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="80" cy="80" r={r} fill="none" stroke={C.border} strokeWidth="12" />
        <circle cx="80" cy="80" r={r} fill="none" stroke={col} strokeWidth="12" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} style={{ "--off": off, animation: "dash 1.1s ease both" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 44, color: C.ink, lineHeight: 1 }}>{score}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>/ 100 ready</div>
        </div>
      </div>
    </div>
  );
}
function btn(primary) {
  return primary
    ? { padding: "11px 18px", borderRadius: 11, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14.5, color: "#fff", background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`, fontFamily: BODY }
    : { padding: "11px 18px", borderRadius: 11, cursor: "pointer", fontWeight: 600, fontSize: 14.5, color: C.ink, background: "#fff", border: `1.5px solid ${C.border}`, fontFamily: BODY };
}
