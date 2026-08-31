import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isBuiltInPlatformId,
  platformSlug,
  type PlatformDescriptor,
  type PlatformId,
} from "vic-requirements-elicitation";

// User-added custom project platforms (project harness feature). Stored
// alongside users.json under PROJECTS_ROOT — not ~/.vic — so every machine
// pointed at the same shared drive sees the same custom platforms (same
// rationale as UsersStore). Built-in platforms are never stored here; the
// API layer concatenates BUILT_IN_PLATFORMS with this list.
interface PlatformStoreData {
  customPlatforms: PlatformDescriptor[];
}

export interface AddCustomPlatformInput {
  label: string;
  entryPointHint: string;
  wiringHint: string;
  lifecycleHint: string;
  createdBy: string;
}

export class PlatformStore {
  private readonly file: string;

  constructor(projectsRoot: string) {
    this.file = path.join(projectsRoot, "platforms.json");
  }

  private async readAll(): Promise<PlatformStoreData> {
    try {
      const raw = await readFile(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PlatformStoreData>;
      return {
        customPlatforms: Array.isArray(parsed.customPlatforms)
          ? parsed.customPlatforms
          : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { customPlatforms: [] };
      throw err;
    }
  }

  private async writeAll(data: PlatformStoreData): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(data, null, 2), "utf-8");
  }

  async listCustom(): Promise<PlatformDescriptor[]> {
    return (await this.readAll()).customPlatforms;
  }

  // Adds a custom platform. The id is derived from the label
  // ("custom:<slug>"); a collision with an existing custom id or a built-in
  // id is rejected. Anyone may call this (no admin gate — user decision).
  async addCustom(input: AddCustomPlatformInput): Promise<PlatformDescriptor> {
    const label = input.label.trim();
    if (!label) throw new Error("label is required");
    const id: PlatformId = `custom:${platformSlug(label)}`;
    if (isBuiltInPlatformId(id))
      throw new Error(`"${label}" collides with a built-in platform`);
    const data = await this.readAll();
    if (data.customPlatforms.some((p) => p.id === id)) {
      throw new Error(`a custom platform named "${label}" already exists`);
    }
    const descriptor: PlatformDescriptor = {
      id,
      label,
      entryPointHint: input.entryPointHint.trim(),
      wiringHint: input.wiringHint.trim(),
      lifecycleHint: input.lifecycleHint.trim(),
      builtIn: false,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    data.customPlatforms.push(descriptor);
    await this.writeAll(data);
    return descriptor;
  }

  // Removes a custom platform. Built-in ids are rejected. A project still
  // referencing the deleted id keeps working — its platform badge just
  // shows the raw id until the user picks a different one (user decision).
  async deleteCustom(id: PlatformId): Promise<void> {
    if (isBuiltInPlatformId(id))
      throw new Error("built-in platforms cannot be deleted");
    const data = await this.readAll();
    const next = data.customPlatforms.filter((p) => p.id !== id);
    if (next.length === data.customPlatforms.length)
      throw new Error(`no custom platform with id "${id}"`);
    await this.writeAll({ customPlatforms: next });
  }

  // Resolve an id against built-ins + the stored custom list.
  async resolve(
    id: PlatformId | null | undefined,
  ): Promise<PlatformDescriptor | undefined> {
    if (!id) return undefined;
    const { BUILT_IN_PLATFORMS } = await import("vic-requirements-elicitation");
    return [...BUILT_IN_PLATFORMS, ...(await this.listCustom())].find(
      (p) => p.id === id,
    );
  }
}
