import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { TaskStatus } from "@/generated/prisma/enums";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const status = searchParams.get("status") as TaskStatus | null;

  const where = status ? { status } : {};

  const tasks = await prisma.task.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { installation: true },
  });

  return NextResponse.json(tasks);
}
