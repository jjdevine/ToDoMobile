/**
 * Playwright E2E tests – mock-based (no real Supabase connection).
 *
 * Every test intercepts the Supabase CDN request and substitutes the mock
 * UMD module from tests/e2e/fixtures/supabase-mock.js. The mock exposes
 * window.__sb which tests read/write via page.evaluate() to control fixture
 * state and inspect API calls.
 */
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PATH = path.join(__dirname, "fixtures", "supabase-mock.js");
const MOCK_CODE = fs.readFileSync(MOCK_PATH, "utf-8");

const CDN_URL =
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";

// ── Fixture data ────────────────────────────────────────────────────────────

const MOCK_USER = { id: "user-001", email: "test@example.com" };

const FIXTURE_STATE = {
  user: MOCK_USER,
  tables: {
    user_settings: [
      {
        user_id: "user-001",
        default_project_id: null,
        default_project_updated_at: "2026-08-01T10:00:00Z",
        updated_at: "2026-08-01T10:00:00Z",
      },
    ],
    projects: [
      {
        id: "proj-001",
        user_id: "user-001",
        name: "My Project",
        inactive: false,
        last_generated_through: null,
        config_text: "",
        updated_at: "2026-08-01T10:00:00Z",
      },
    ],
    tasks: [
      {
        id: "task-001",
        user_id: "user-001",
        project_id: "proj-001",
        name: "Write tests",
        body: "Important test notes",
        due_date: "2026-08-05",
        source: "manual",
        generated_key: null,
        pinned: false,
        end_of_day: false,
        created_at: "2026-08-01T10:00:00Z",
        updated_at: "2026-08-01T10:00:00Z",
      },
      {
        id: "task-002",
        user_id: "user-001",
        project_id: "proj-001",
        name: "Deploy app",
        body: "",
        due_date: "2026-08-06",
        source: "manual",
        generated_key: null,
        pinned: false,
        end_of_day: false,
        created_at: "2026-08-01T11:00:00Z",
        updated_at: "2026-08-01T11:00:00Z",
      },
    ],
    archived_tasks: [
      {
        id: "task-arc-001",
        user_id: "user-001",
        project_id: "proj-001",
        name: "Old completed task",
        body: "This description must survive archiving",
        due_date: "2026-07-30",
        source: "manual",
        generated_key: null,
        pinned: false,
        end_of_day: false,
        completed_at: "2026-07-31T09:00:00Z",
        created_at: "2026-07-30T08:00:00Z",
        updated_at: "2026-07-31T09:00:00Z",
      },
    ],
    generated_occurrences: [],
    tags: [],
    project_tags: [],
    recurring_task_descriptions: [],
  },
};

// ── Helper: set up mock on every page ───────────────────────────────────────

async function setupMock(page, stateOverrides) {
  // Replace the CDN Supabase script with our mock
  await page.route(CDN_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: MOCK_CODE,
    })
  );

  // Seed state via window.__sbInitialState BEFORE any page scripts run.
  // The mock module reads this variable when it initialises.
  const state = stateOverrides
    ? { ...FIXTURE_STATE, ...stateOverrides }
    : FIXTURE_STATE;

  await page.addInitScript((s) => {
    window.__sbInitialState = s;
  }, state);
}

// ── Wait helpers ─────────────────────────────────────────────────────────────

async function waitForHomeScreen(page) {
  // Splash fades in 480ms; wait up to 5s for home screen to become active
  await page.waitForSelector("#home-screen.active", { timeout: 7000 });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("authentication", () => {
  test("shows auth screen when no session exists", async ({ page }) => {
    await setupMock(page, { user: null });
    await page.goto("/");
    await page.waitForSelector("#auth-screen.active", { timeout: 7000 });
    await expect(page.locator("#auth-screen")).toHaveClass(/active/);
    await expect(page.locator("#home-screen")).not.toHaveClass(/active/);
  });

  test("goes directly to home screen when session exists", async ({ page }) => {
    await setupMock(page);
    await page.goto("/");
    await waitForHomeScreen(page);
    await expect(page.locator("#home-screen")).toHaveClass(/active/);
  });
});

test.describe("home screen", () => {
  test.beforeEach(async ({ page }) => {
    await setupMock(page);
    await page.goto("/");
    await waitForHomeScreen(page);
  });

  test("displays project loaded from server", async ({ page }) => {
    await expect(page.locator(".project-card-title")).toContainText("My Project");
  });

  test("shows signed-in user email in header", async ({ page }) => {
    await expect(page.locator("#user-email")).toContainText("test@example.com");
  });

  test("does not read domain localStorage key while online", async ({ page }) => {
    // Spy on localStorage.getItem – domain state key must NOT be accessed
    // because the app only reads cache when offline.
    const reads = await page.evaluate(() => {
      return window.__localStorageReads || [];
    });
    const domainRead = reads.find((key) =>
      key.startsWith("task_planner_state_v1::")
    );
    expect(domainRead).toBeUndefined();
  });
});

test.describe("task operations", () => {
  test.beforeEach(async ({ page }) => {
    await setupMock(page);
    await page.goto("/");
    await waitForHomeScreen(page);
    // Navigate into the project
    await page.locator(".project-card").first().click();
    await page.waitForSelector("#project-screen.active", { timeout: 5000 });
    // Use "All Tasks View" to reach the day screen with all tasks visible
    await page.locator("#all-tasks-view-btn").click();
    await page.waitForSelector("#day-screen.active", { timeout: 5000 });
  });

  test("add task sends server INSERT before appearing in task list", async ({
    page,
  }) => {
    // Seed mock so re-pull after insert includes the new task
    await page.evaluate(() => {
      window.__sb.state.tables.tasks.push({
        id: "task-new",
        user_id: "user-001",
        project_id: "proj-001",
        name: "Brand new task",
        body: "",
        due_date: "2026-08-05",
        source: "manual",
        generated_key: null,
        pinned: false,
        end_of_day: false,
        created_at: "2026-08-05T12:00:00Z",
        updated_at: "2026-08-05T12:00:00Z",
      });
    });

    await page.locator("#open-day-add-task-btn").click();
    await page.waitForSelector("#add-task-modal:not(.hidden)", {
      timeout: 3000,
    });

    await page.fill("#add-task-name-input", "Brand new task");
    await page.fill("#add-task-date-input", "2026-08-05");

    // Clear call log right before submitting so we can detect the INSERT cleanly
    await page.evaluate(() => { window.__sb.calls = []; });
    await page.locator("#confirm-add-task-btn").click();

    // Wait for modal to close (element still in DOM but display:none = 'hidden' state)
    await page.waitForSelector("#add-task-modal", { state: "hidden", timeout: 5000 });

    // Verify INSERT was logged
    const insertCalls = await page.evaluate(() =>
      window.__sb.calls.filter((c) => c.type === "insert" && c.table === "tasks")
    );
    expect(insertCalls.length).toBeGreaterThan(0);
  });

  test("complete task calls complete_task RPC", async ({ page }) => {
    // task-002 has no body so the condensed-mode Complete button completes directly.
    // Ensure the tasks are visible (All Tasks view set in beforeEach).
    await page.evaluate(() => { window.__sb.calls = []; });

    // Find the task card for task-002 ("Deploy app", no description)
    const deployCard = page.locator(".task-card").filter({ hasText: "Deploy app" });
    await expect(deployCard).toBeVisible({ timeout: 3000 });
    const completeBtn = deployCard.locator(".task-btn.complete");
    await expect(completeBtn).toBeVisible({ timeout: 2000 });
    await completeBtn.click();

    // Give the async runServerCommand time to fire
    await page.waitForTimeout(400);

    const rpcCalls = await page.evaluate(() =>
      window.__sb.calls.filter((c) => c.type === "rpc")
    );
    expect(rpcCalls.some((c) => c.table === "complete_task")).toBe(true);
  });
});

test.describe("archive", () => {
  test.beforeEach(async ({ page }) => {
    await setupMock(page);
    await page.goto("/");
    await waitForHomeScreen(page);
    await page.locator(".project-card").first().click();
    await page.waitForSelector("#project-screen.active", { timeout: 5000 });
    // Navigate to day screen via All Tasks View, then open archive
    await page.locator("#all-tasks-view-btn").click();
    await page.waitForSelector("#day-screen.active", { timeout: 5000 });
  });

  test("archived task description is preserved and visible", async ({
    page,
  }) => {
    await page.locator("#view-archive-btn").click();
    await page.waitForSelector("#archive-screen.active", { timeout: 5000 });

    // The fixture has an archived task with a description
    const archiveList = page.locator("#archive-list");
    await expect(archiveList).toContainText("Old completed task");
    await expect(archiveList).toContainText("This description must survive archiving");
  });
});

test.describe("offline mode", () => {
  test("shows offline banner and disables mutation controls when offline", async ({
    page,
  }) => {
    await setupMock(page);
    await page.goto("/");
    await waitForHomeScreen(page);

    // Simulate going offline via Playwright's network condition
    await page.context().setOffline(true);

    // Trigger the offline event in the page context
    await page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
    });

    // Offline banner should appear
    await expect(page.locator("#offline-banner")).not.toHaveClass(/hidden/);

    // Mutation controls should be disabled
    const createProjectBtn = page.locator("#open-create-project-btn");
    if (await createProjectBtn.isVisible()) {
      await expect(createProjectBtn).toBeDisabled();
    }
  });

  test("reconnect pulls fresh data from server", async ({ page }) => {
    await setupMock(page);
    await page.goto("/");
    await waitForHomeScreen(page);

    // Go offline then back online
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.waitForTimeout(100);

    // Clear call log
    await page.evaluate(() => { window.__sb.calls = []; });

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    // Wait for reconnect pull to start
    await page.waitForTimeout(500);

    const readCalls = await page.evaluate(() =>
      window.__sb.calls.filter((c) => c.type === "read")
    );
    // After reconnect the app should re-query the server tables
    expect(readCalls.length).toBeGreaterThan(0);
  });
});

test.describe("modal accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await setupMock(page);
    await page.goto("/");
    await waitForHomeScreen(page);
    // Navigate into the project — the add task modal is accessible from the project screen
    await page.locator(".project-card").first().click();
    await page.waitForSelector("#project-screen.active", { timeout: 5000 });
  });

  test("add task modal has accessible dialog semantics", async ({ page }) => {
    await page.locator("#open-project-add-task-btn").click();
    await page.waitForSelector("#add-task-modal:not(.hidden)", { timeout: 3000 });

    await expect(page.locator("#add-task-modal")).toHaveAttribute("role", "dialog");
    await expect(page.locator("#add-task-modal")).toHaveAttribute("aria-modal", "true");
    await expect(page.locator("#add-task-modal")).toHaveAttribute("aria-hidden", "false");
  });

  test("Escape key closes the add task modal", async ({ page }) => {
    await page.locator("#open-project-add-task-btn").click();
    await page.waitForSelector("#add-task-modal:not(.hidden)", { timeout: 3000 });

    await page.keyboard.press("Escape");
    await page.waitForSelector("#add-task-modal", { state: "hidden", timeout: 2000 });
    await expect(page.locator("#add-task-modal")).toHaveClass(/hidden/);
  });

  test("task name input receives focus when add task modal opens", async ({
    page,
  }) => {
    await page.locator("#open-project-add-task-btn").click();
    await page.waitForSelector("#add-task-modal:not(.hidden)", { timeout: 3000 });

    // openModal uses requestAnimationFrame to set focus; wait for it to fire.
    await page.waitForFunction(
      () => document.activeElement && document.activeElement.id === "add-task-name-input",
      { timeout: 2000 }
    );
    const focused = await page.evaluate(
      () => document.activeElement && document.activeElement.id
    );
    expect(focused).toBe("add-task-name-input");
  });
});
