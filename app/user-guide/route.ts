/**
 * Cycle 42 Phase 4c — User Guide route handler.
 *
 * Serves the standalone `docs/user-docs/index.html` documentation site
 * behind tool auth. The HTML is the single source of truth; editing
 * docs = editing that file. Served with full inline <script>/<style>
 * intact via NextResponse (NOT dangerouslySetInnerHTML which would skip
 * script execution).
 *
 * Build packaging: `experimental.outputFileTracingIncludes` in
 * `next.config.mjs` copies `docs/user-docs/index.html` into the
 * standalone server output. Without it, `output: "standalone"` would
 * not bundle the file and the route would 500 on Railway.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";

// Read once at server start. The file is shipped into the standalone
// output via outputFileTracingIncludes; if it's missing, the read throws
// and the server fails to start — loud failure preferred over a silent
// 404 in production.
const USER_GUIDE_HTML = readFileSync(
  join(process.cwd(), "docs/user-docs/index.html"),
  "utf-8",
);

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return new NextResponse(USER_GUIDE_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    },
  });
}
