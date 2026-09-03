import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../../helpers/auth";

test.describe("Realmroot web session", () => {
  test("[spec: authentication/server-session] uses an HttpOnly AK session cookie without browser token storage", async ({ page, context }) => {
    const email = `realmroot_session_${Date.now()}@example.com`;
    await signUpAndGetBoard(page, email, "Realmroot User");

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === "ak_session");
    // Chromium downgrades manually seeded Secure cookies on the HTTP localhost test origin.
    // HttpOnly and SameSite still prove the browser-session boundary used by the app.
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });

    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { credentials: "include" });
      return { status: response.status, body: await response.json() };
    });
    expect(session.status).toBe(200);
    expect(session.body.user).toMatchObject({ email, name: "Realmroot User" });
    expect(session.body.user.tenantId).toMatch(/^user:e2e:/);
    expect(await page.evaluate(() => localStorage.getItem("auth-token"))).toBeNull();
  });

  test("[spec: authentication/server-session] [spec: authentication/logout] requires CSRF and destroys the local AK session before Realmroot logout", async ({
    page,
    context,
  }) => {
    await signUpAndGetBoard(page, `realmroot_logout_${Date.now()}@example.com`, "Realmroot Logout User");

    const result = await page.evaluate(async () => {
      const sessionResponse = await fetch("/api/auth/session", { credentials: "include" });
      const session = (await sessionResponse.json()) as { session: { csrfToken: string } };

      const missingCsrf = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
      const afterRejectedLogout = await fetch("/api/auth/session", { credentials: "include" });

      const logout = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": session.session.csrfToken },
      });
      const logoutBody = (await logout.json()) as { logoutUrl: string };
      const afterLogout = await fetch("/api/auth/session", { credentials: "include" });

      return {
        missingCsrfStatus: missingCsrf.status,
        afterRejectedLogoutStatus: afterRejectedLogout.status,
        logoutStatus: logout.status,
        logoutUrl: logoutBody.logoutUrl,
        afterLogoutStatus: afterLogout.status,
      };
    });

    expect(result).toMatchObject({
      missingCsrfStatus: 403,
      afterRejectedLogoutStatus: 200,
      logoutStatus: 200,
      afterLogoutStatus: 401,
    });
    const logoutUrl = new URL(result.logoutUrl);
    expect(logoutUrl.origin + logoutUrl.pathname).toBe("https://id.realmroot.dev/api/auth/oauth2/end-session");
    expect(logoutUrl.searchParams.get("post_logout_redirect_uri")).toBe("https://bodev.agent-kanban.dev/");
    expect((await context.cookies()).some((cookie) => cookie.name === "ak_session")).toBe(false);
  });

  test("rejects logout without an active AK session", async ({ page }) => {
    await page.goto("/auth");
    const response = await page.evaluate(async () => {
      const logout = await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      return { status: logout.status, body: await logout.json() };
    });

    expect(response).toEqual({
      status: 401,
      body: { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
    });
  });
});
