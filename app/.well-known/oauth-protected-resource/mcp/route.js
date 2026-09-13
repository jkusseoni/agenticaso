import {
  protectedResourceHandlerClerk,
  metadataCorsOptionsRequestHandler,
} from "@clerk/mcp-tools/next";

const GET = protectedResourceHandlerClerk({
  scopes_supported: ["openid", "profile", "email"],
});

const OPTIONS = metadataCorsOptionsRequestHandler();

export { GET, OPTIONS };
