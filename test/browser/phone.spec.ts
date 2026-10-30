// The built page in a real browser under its Content-Security-Policy: choose "sign with your phone" with the test
// wallet's address (read-only; the page reads its boxes from the live explorer), build a 0.001 ERG pool swap, and see
// the QR panel render from sigma-rust's WASM binding, with an ergopay: link of at most 2,800 characters. Nothing is
// signed or submitted: no wallet sees the transaction, and the page's chain upkeep is switched off first.
import { expect, test } from "@playwright/test";

/** The test wallet of skunkyard SK-063 (skunks/dexpage/RESULT.md); the page only reads its boxes. */
const ADDRESS = "9gnBiuBAy4GgGEk1MZQ5f7aWWuQnyGHNVVF4bvhHKWvecWTNcfc";
const QR_MAX_CHARS = 2800;

test("the CSP is set, the WASM path reduces a swap, and the QR panel shows a link within the limit", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // the page's first poll for the transaction id is a 404 from the explorer by design (not seen yet); the
    // browser logs every failed resource load as an error, so those are not failures here
    if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text())) errors.push(m.text());
  });
  page.on("dialog", (d) => d.accept(ADDRESS));

  await page.goto("/");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    /script-src 'self' 'wasm-unsafe-eval'/,
  );
  // the explorer has answered when the pool listing is logged
  await expect(page.locator("#log")).toContainText(/\d+ ERG pools and \d+ token-to-token pools/, { timeout: 60_000 });

  // no upkeep: the page must submit nothing while this runs
  await page.locator("#upkeep-on").uncheck();
  await page.getByRole("button", { name: /^sign with your phone/ }).click();
  await expect(page.locator("#wallet")).toContainText(/^phone: 9gnBiuBA…WTNcfc/);

  // 0.001 ERG into a token with enough decimals to receive something (SigUSD, the default, has two: the quote is 0)
  const rsn = await page
    .locator("#swap-to option", { hasText: /^RSN\b/ })
    .first()
    .getAttribute("value");
  await page.locator("#swap-to").selectOption(rsn!);
  await page.locator("#swap-in").fill("0.001");
  await expect(page.locator("#swap-quote")).toContainText("You receive (estimate)");
  await expect(page.locator("#swap-go")).toBeEnabled();
  await page.locator("#swap-go").click();

  const panel = page.locator("#ergopay");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#ergopay-txid")).toHaveText(/^[0-9a-f]{64}$/);
  const href = await page.locator("#ergopay-link").getAttribute("href");
  expect(href).toMatch(/^ergopay:[A-Za-z0-9_-]+=*$/);
  expect(href!.length).toBeLessThanOrEqual(QR_MAX_CHARS);
  // the code was drawn: a square canvas with a QR module count in its title
  await expect(page.locator("#ergopay-qr")).toHaveAttribute("title", /^\d+×\d+ modules$/);
  const [w, h] = await page.locator("#ergopay-qr").evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
  expect(w).toBeGreaterThan(100);
  expect(w).toBe(h);
  await expect(page.locator("#log")).toContainText(/reduced to \d+ bytes, a \d+-character link/);
  // focus moved to the panel when it opened
  await expect(panel).toBeFocused();

  await page.locator("#ergopay-cancel").click();
  expect(errors, "no page or console error").toEqual([]);
});
