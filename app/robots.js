export default function robots() {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://agenticaso.com").replace(/\/$/, "");
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
      {
        userAgent: "OAI-AdsBot",
        allow: "/",
      },
      {
        userAgent: "OAI-SearchBot",
        allow: "/",
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
