export default function sitemap() {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://agenticaso.com";
  const paths = ["/", "/pricing", "/terms", "/privacy", "/refund-cancellation", "/contact"];
  return paths.map((path) => ({
    url: `${base.replace(/\/$/, "")}${path}`,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.6,
  }));
}
