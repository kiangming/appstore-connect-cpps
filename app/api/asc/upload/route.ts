import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { reserveScreenshot, confirmScreenshot, uploadAssetToOperations } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const screenshotSetId = formData.get("screenshotSetId") as string | null;
    const file = formData.get("file") as File | null;

    if (!screenshotSetId || !file) {
      return NextResponse.json(
        { error: "screenshotSetId and file are required" },
        { status: 400 }
      );
    }

    const creds = await getActiveAccount();

    // Step 1: Reserve an upload slot
    const reserved = await reserveScreenshot(creds, screenshotSetId, file.name, file.size);
    const screenshot = reserved.data;
    const uploadOperations = screenshot.attributes.uploadOperations;

    if (!uploadOperations || uploadOperations.length === 0) {
      throw new Error("No upload operations returned from ASC API");
    }

    // Step 2: Upload file chunks directly to presigned URLs
    await uploadAssetToOperations(uploadOperations, file);

    // Step 3: Compute MD5 checksum server-side and confirm upload
    const buffer = Buffer.from(await file.arrayBuffer());
    const checksum = createHash("md5").update(buffer).digest("hex");

    const confirmed = await confirmScreenshot(creds, screenshot.id, checksum);
    return NextResponse.json(confirmed, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("upload", `[API] POST /api/asc/upload error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
