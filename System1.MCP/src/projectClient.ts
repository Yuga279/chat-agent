import { config } from "./config.js";
import { getAccessToken } from "./tokenClient.js";
import { resolveTenantId } from "./tenantClient.js";

async function baseRoute(externalUserId: string): Promise<string> {
  const tenantId = await resolveTenantId(externalUserId);
  return `${config.apiBaseUrl}/api/v1/${tenantId}/Project`;
}

async function callApi<T>(externalUserId: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken(externalUserId);
  const route = await baseRoute(externalUserId);
  const response = await fetch(`${route}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`System1 API call failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

export interface ProjectMemberModel {
  id?: string;
  fullName?: string;
}

export interface ProjectTagModel {
  id?: string;
  name?: string;
}

export interface ProjectSummaryModel {
  id: string;
  code: number;
  name: string;
  description: string;
  createdBy: string;
  ownedBy?: string;
  isResponse: boolean;
  tags: ProjectTagModel[];
  members: ProjectMemberModel[];
}

interface ProjectListingResponse {
  isOk?: boolean;
  pmoProjects: ProjectSummaryModel[];
  totalCount: number;
}

export interface ListProjectsParams {
  page?: number;
  pageSize?: number;
  /** Free-text project name filter; sent as a generic column filter (API takes a name/value pair list, not a typed search param). */
  search?: string;
}

/** Lists projects for the caller's tenant, paged. */
export async function listProjects(
  externalUserId: string,
  params: ListProjectsParams = {},
): Promise<{ projects: ProjectSummaryModel[]; totalCount: number }> {
  const body = {
    page: params.page ?? 1,
    pageSize: params.pageSize ?? 50,
    sort: null,
    columnFilters: params.search ? [{ name: "Name", value: params.search }] : [],
  };

  const response = await callApi<ProjectListingResponse>(externalUserId, "", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return { projects: response.pmoProjects ?? [], totalCount: response.totalCount ?? 0 };
}

export interface ProjectTaskModel {
  id: string;
  code: number;
  name: string;
  description: string;
  isDefaultTask: boolean;
}

export interface ProjectDetailModel {
  id: string;
  code: number;
  name: string;
  description: string;
  ownedBy?: string;
  isOwner: boolean;
  startDate?: string;
  endDateBaseline?: string;
  endDateRevised?: string;
  completedOn?: string;
  archivedOn?: string;
  timeSpent: number;
  tasks: ProjectTaskModel[];
  members: ProjectMemberModel[];
}

interface ProjectDetailViewResponse {
  isOk?: boolean;
  project: ProjectDetailModel;
}

/** Fetches full details (including tasks and members) for a single project by id. */
export async function getProjectDetails(externalUserId: string, projectId: string): Promise<ProjectDetailModel> {
  const response = await callApi<ProjectDetailViewResponse>(externalUserId, `/${projectId}`, { method: "GET" });
  return response.project;
}
