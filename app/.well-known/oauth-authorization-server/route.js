import {
  authServerMetadataHandlerClerk,
  metadataCorsOptionsRequestHandler,
} from "@clerk/mcp-tools/next";

const GET = authServerMetadataHandlerClerk();
const OPTIONS = metadataCorsOptionsRequestHandler();

export { GET, OPTIONS };
