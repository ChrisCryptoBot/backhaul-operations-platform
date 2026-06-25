import { expect, test } from "@playwright/test";

async function prepareDeterministicState(page: import("@playwright/test").Page, theme: "light" | "dark") {
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("db-theme", selectedTheme);
    document.documentElement.setAttribute("data-theme", selectedTheme);
  }, theme);
}

test.describe("design baselines", () => {
  test("board baseline", async ({ page }) => {
    await prepareDeterministicState(page, "light");
    await page.goto("/visual-regression?surface=board");
    await page.addStyleTag({
      content:
        "*{animation:none !important;transition:none !important;} .db-table-wrap{scroll-behavior:auto !important;}"
    });
    await expect(page.getByTestId("visual-board")).toHaveScreenshot("board-light.png");
  });

  test("kpi trend baseline", async ({ page }) => {
    await prepareDeterministicState(page, "light");
    await page.goto("/visual-regression?surface=kpi");
    await page.addStyleTag({
      content:
        "*{animation:none !important;transition:none !important;} .db-tabs-body{scroll-behavior:auto !important;}"
    });
    await page.getByRole("tab", { name: "Trend" }).click();
    await page.getByRole("combobox", { name: "Trend window" }).selectOption("12");
    await expect(page.getByTestId("visual-kpi")).toHaveScreenshot("kpi-trend-light.png");
  });

  test("kpi trend baseline dark dense window", async ({ page }) => {
    await prepareDeterministicState(page, "dark");
    await page.goto("/visual-regression?surface=kpi");
    await page.addStyleTag({
      content:
        "*{animation:none !important;transition:none !important;} .db-tabs-body{scroll-behavior:auto !important;}"
    });
    await page.getByRole("tab", { name: "Trend" }).click();
    await page.getByRole("combobox", { name: "Trend window" }).selectOption("12");
    await expect(page.getByTestId("visual-kpi")).toHaveScreenshot("kpi-trend-dark-12w.png");
  });

  test("kpi management baseline", async ({ page }) => {
    await prepareDeterministicState(page, "dark");
    await page.goto("/visual-regression?surface=kpi");
    await page.addStyleTag({
      content:
        "*{animation:none !important;transition:none !important;} .db-tabs-body{scroll-behavior:auto !important;}"
    });
    await page.getByRole("tab", { name: "Management Report" }).click();
    await expect(page.getByTestId("visual-kpi")).toHaveScreenshot("kpi-management-dark.png");
  });

  test("review baseline", async ({ page }) => {
    await prepareDeterministicState(page, "dark");
    await page.goto("/visual-regression?surface=review");
    await page.addStyleTag({
      content:
        "*{animation:none !important;transition:none !important;} .db-review-table-wrap{scroll-behavior:auto !important;}"
    });
    await page.getByRole("checkbox", { name: "Enable exception workflow" }).check();
    await page.getByLabel("Reject reason").fill("Missing signature");
    await expect(page.getByTestId("visual-review")).toHaveScreenshot("review-exception-dark.png");
  });
});
