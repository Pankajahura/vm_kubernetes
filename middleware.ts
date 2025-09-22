import { type NextRequest } from "next/server";
import { NextResponse } from "next/server"; // added

// ---------- IP cooldown config ----------
const WINDOW_MS = 60_000; // 1 minute window
const MAX_REQUESTS = 30; // allow 20 requests per IP per window
const COOLDOWN_MS = 5 * 60_000; // 5 minutes cooldown when exceeded

type IpRecord = {
  count: number;
  windowStart: number;
  cooldownUntil: number | null;
};

// In-memory store (single instance only; use Redis/Upstash for multi-instance)
const ipStore = new Map<string, IpRecord>();

function getClientIp(req: NextRequest): string {
  return (
    // req.ip ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function applyIpCooldown(req: NextRequest): NextResponse | null {
  const ip = getClientIp(req);
  const now = Date.now();

  const rec = ipStore.get(ip);

  // still cooling down?
  if (rec?.cooldownUntil && now < rec.cooldownUntil) {
    const msLeft = rec.cooldownUntil - now;
    return new NextResponse(
      JSON.stringify({
        error: "Too many requests. Try again later.",
        cooldown_ms: msLeft,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": Math.ceil(msLeft / 1000).toString(),
        },
      },
    );
  }

  // new window
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    ipStore.set(ip, { count: 1, windowStart: now, cooldownUntil: null });
    return null;
  }

  // same window: increment
  rec.count += 1;

  // exceeded -> start cooldown
  if (rec.count > MAX_REQUESTS) {
    rec.cooldownUntil = now + COOLDOWN_MS;
    ipStore.set(ip, rec);
    return new NextResponse(
      JSON.stringify({
        error: "Too many requests. Try again later.",
        cooldown_ms: COOLDOWN_MS,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": Math.ceil(COOLDOWN_MS / 1000).toString(),
        },
      },
    );
  }

  ipStore.set(ip, rec);
  return null;
}
// ---------------------------------------

export async function middleware(request: NextRequest) {
    //debugger
  // IP cooldown check (early return if limited)
  console.log("middleware---calling---1");
  const limited = applyIpCooldown(request);
  if (limited) return limited;
  console.log(
    request?.headers?.get("x-client-secret"),
    ".....................89",
    process.env.NEXT_PUBLIC_CLIENT_SECRET,
    "....NEXT_PUBLIC_CLIENT_SECRET",
  );
  if (
    request?.headers?.get("x-client-secret") !==
    process.env.NEXT_PUBLIC_CLIENT_SECRET
  ) {
    return new NextResponse(
      JSON.stringify({
        error: "this link is protected # cors protection",
        // cooldown_ms: msLeft,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          //"Retry-After": Math.ceil(msLeft / 1000).toString(),
        },
      },
    );
  }

  //console.log('middleware---calling---5');
 //return await updateSession(request);
// next()
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * Feel free to modify this pattern to include more paths.
     */
    // "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    "/api/clusters",
    "/api/auth/signin/email",
    "/api/auth/signup",
  ],
};
