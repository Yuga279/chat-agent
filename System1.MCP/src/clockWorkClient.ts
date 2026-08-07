import { config } from "./config.js";
import { getAccessToken } from "./tokenClient.js";
import { resolveTenantId } from "./tenantClient.js";

async function baseRoute(externalUserId: string): Promise<string> {
  const tenantId = await resolveTenantId(externalUserId);
  return `${config.apiBaseUrl}/api/v1/${tenantId}/ClockWork`;
}

interface LiveViewUserModeEntryModel {
  clockWorkEntryId?: string;
  startTime: string;
  endTime?: string;
  totalTimeInSeconds: number;
  projectDisplayString?: string;
  taskDisplayString?: string;
  description?: string;
}

interface ClockWorkEntryOperationItem {
  runningLiveEntry?: LiveViewUserModeEntryModel;
}

interface ClockWorkEntryOperationResponse {
  isOk: boolean;
  message?: string;
  item: ClockWorkEntryOperationItem;
}

interface ClockWorkEntriesResponse {
  isOk: boolean;
  message?: string;
  item: { employeeId: string };
}

async function callApi<T>(externalUserId: string, path: string, body: unknown): Promise<T> {
  const token = await getAccessToken(externalUserId);
  const route = await baseRoute(externalUserId);
  const response = await fetch(`${route}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`System1 API call failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

export interface StartEntryParams {
  projectId?: string;
  taskId?: string;
  description?: string;
  startTime?: string;
}

export async function startEntry(
  externalUserId: string,
  params: StartEntryParams,
): Promise<ClockWorkEntryOperationResponse> {
  return callApi<ClockWorkEntryOperationResponse>(externalUserId, "", {
    type: "add",
    entryPayload: {
      projectId: params.projectId,
      taskId: params.taskId,
      description: params.description ?? "",
      startTime: params.startTime ?? new Date().toISOString(),
    },
  });
}

export interface EndEntryParams {
  entryId: string;
}

export async function endEntry(
  externalUserId: string,
  params: EndEntryParams,
): Promise<ClockWorkEntryOperationResponse> {
  return callApi<ClockWorkEntryOperationResponse>(externalUserId, "", {
    type: "end",
    entryPayload: {
      id: params.entryId,
    },
  });
}

export interface ClockWorkEntryModel {
  id: string;
  description: string;
  startTime: string;
  endTime: string | null;
  employeeId: string;
  timeZone: string;
  startTimeTzFormatted: string;
  endTimeTzFormatted: string;
  totalTimeInSeconds: number;
  timeSinceMidNightInMinutes: number;
  projectDisplayString: string;
  taskDisplayString: string;
  projectId: string;
  taskId: string;
  fullName: string;
  profileImageURL: string;
  entryAtWork: boolean;
  isMember: boolean;
}

interface ClockWorkEntriesByDateResponse {
  clockWorkEntries: ClockWorkEntryModel[];
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Fetches all ClockWork entries for the caller on the given day (yyyy-MM-dd; defaults to today). */
export async function getEntriesByDate(externalUserId: string, date?: string): Promise<ClockWorkEntryModel[]> {
  const token = await getAccessToken(externalUserId);
  const route = await baseRoute(externalUserId);
  const entryDate = date ?? formatDate(new Date());

  const response = await fetch(`${route}/${entryDate}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`System1 API call failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as ClockWorkEntriesByDateResponse;
  return body.clockWorkEntries ?? [];
}

/**
 * Finds the caller's currently active (endTime == null) entry for today.
 * Note: the API's getRunningEntries endpoint only surfaces entries carried over
 * from PRIOR days (ClockWorkService.GetClockWorkRunningEntries filters
 * StartTime < startOfDayInUtc) - it does not report today's in-progress entry.
 */
export async function getActiveEntryForToday(externalUserId: string): Promise<ClockWorkEntryModel | undefined> {
  const entries = await getEntriesByDate(externalUserId);
  return entries.find((e) => e.endTime === null);
}

export async function deleteEntries(externalUserId: string, entryIds: string[]): Promise<ClockWorkEntriesResponse> {
  const token = await getAccessToken(externalUserId);
  const route = await baseRoute(externalUserId);
  const response = await fetch(`${route}/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(entryIds),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`System1 API call failed (${response.status}): ${text}`);
  }

  return (await response.json()) as ClockWorkEntriesResponse;
}
