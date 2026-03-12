import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { reservePreview, confirmPreview, uploadAssetToOperations } from "@/lib/asc-client";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const previewSetId = formData.get("previewSetId") as string | null;
    const file = formData.get("file") as File | null;

    if (!previewSetId || !file) {
      return NextResponse.json(
        { error: "previewSetId and file are required" },
        { status: 400 }
      );
    }

    // Step 1: Reserve an upload slot
    const mimeType = file.type || "video/mp4";
    const reserved = await reservePreview(previewSetId, file.name, file.size, mimeType);
    const preview = reserved.data;
    const uploadOperations = preview.attributes.uploadOperations;

    if (!uploadOperations || uploadOperations.length === 0) {
      throw new Error("No upload operations returned from ASC API");
    }

    // Step 2: Upload file chunks
    await uploadAssetToOperations(uploadOperations, file);

    // Step 3: Compute MD5 and confirm
    const buffer = Buffer.from(await file.arrayBuffer());
    const checksum = createHash("md5").update(buffer).digest("hex");

    const confirmed = await confirmPreview(preview.id, checksum);
    return NextResponse.json(confirmed, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[API] POST /api/asc/upload-preview error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
