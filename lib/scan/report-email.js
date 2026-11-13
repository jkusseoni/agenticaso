const cleanText = (value) =>
  String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();

const escapeHtml = (value) =>
  cleanText(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

export function buildScanReportEmail(report) {
  if (
    !report ||
    report.error ||
    !Number.isFinite(report.total) ||
    !Array.isArray(report.findings) ||
    !Array.isArray(report.issues)
  ) {
    throw new Error("Invalid scan report");
  }

  const domain = cleanText(report.clean).slice(0, 253);
  const score = Math.round(report.total);
  const findings = report.findings.slice(0, 4);
  const issues = report.issues.slice(0, 15);

  const subject = `Agenticaso technical readiness report - ${domain}`;

  const text = [
    `AGENTICASO - TECHNICAL READINESS REPORT`,
    `Website: ${domain}`,
    `Overall score: ${score}/100`,
    "",
    "FOUR READINESS AREAS",
    ...findings.map((f) =>
      `${cleanText(f.t)}: ${Math.round(f.score)}/100\n${cleanText(f.note)}`
    ),
    "",
    "ISSUES AND RECOMMENDED FIXES",
    ...(issues.length
      ? issues.map((issue, i) =>
          `${i + 1}. ${cleanText(issue.problem)}\n` +
          `Severity: ${cleanText(issue.severity)}\n` +
          `Fix: ${cleanText(issue.fix)}`
        )
      : ["No specific issues identified in this limited scan."]),
    "",
    "VERDICT",
    cleanText(report.verdict),
    "",
    "SCAN LIMITATIONS",
    cleanText(report.scanScope),
    "",
    "This report checks selected public technical signals.",
    "It does not verify AI recommendations, sales or checkout success.",
    "",
    "Agenticaso - https://agenticaso.com",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#20243A;line-height:1.6;max-width:640px;margin:auto;padding:24px">
  <h1>Agenticaso</h1>
  <h2>Technical Readiness Report</h2>
  <p><strong>Website:</strong> ${escapeHtml(domain)}</p>
  <p style="font-size:28px;font-weight:bold">${score}/100</p>

  <h3>Four Readiness Areas</h3>

  ${findings.map((f) => `
  <div style="padding:12px 0;border-bottom:1px solid #ddd">
    <strong>${escapeHtml(f.t)}: ${Math.round(f.score)}/100</strong>
    <p>${escapeHtml(f.note)}</p>
  </div>
`).join("")}

  <h3>Issues and Recommended Fixes</h3>
  ${issues.length
    ? issues.map((issue) => `
      <div style="padding:12px 0;border-bottom:1px solid #ddd">
        <strong>${escapeHtml(issue.problem)}</strong>
        <p>Severity: ${escapeHtml(issue.severity)}</p>
        <p><strong>Fix:</strong> ${escapeHtml(issue.fix)}</p>
      </div>
    `).join("")
    : "<p>No specific issues identified in this limited scan.</p>"}

  <h3>Verdict</h3>
  <p>${escapeHtml(report.verdict)}</p>

  <h3>Scan Limitations</h3>
  <p>${escapeHtml(report.scanScope)}</p>

  <p style="font-size:12px;color:#666">
    This technical scan does not verify actual AI recommendations,
    purchases, sales or checkout success.
  </p>

  <p><a href="https://agenticaso.com">Agenticaso</a></p>
</body>
</html>`;

  return { subject, text, html };
}
