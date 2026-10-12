import { afterEach, describe, expect, it } from "vitest";

import {
  assertContainerPolicy,
  containerCreateArguments,
} from "../src/docker.js";
import { comparisonDigest } from "../src/identity.js";
import { runEvaluation } from "../src/runner.js";
import { parseTaskSpec } from "../src/spec.js";
import { batchFor } from "./helpers/batch.js";
import {
  cleanupTestRepositories,
  createTestRepository,
} from "./helpers/repository.js";

const image = `node@sha256:${"a".repeat(64)}`;
afterEach(cleanupTestRepositories);

describe("execution boundary", () => {
  it("requires digest-pinned images and rejects arbitrary runtime options", () => {
    const task = {
      ...batchFor({ path: process.cwd(), revision: "a".repeat(40) }).task,
      adapter: { kind: "fake", actions: [] },
    };
    expect(
      parseTaskSpec({ ...task, execution: { kind: "docker", image } })
        .execution,
    ).toEqual({ kind: "docker", image });
    for (const execution of [
      { kind: "docker", image: "node:latest" },
      { kind: "docker", image, privileged: true },
      { kind: "docker", image, network: "host" },
      { kind: "docker", image, mounts: ["/"] },
    ])
      expect(() => parseTaskSpec({ ...task, execution })).toThrow("execution");
  });

  it("includes effective execution policy and image in shared task identity", () => {
    const task = batchFor({
      path: process.cwd(),
      revision: "a".repeat(40),
    }).task;
    const local = comparisonDigest(task);
    expect(comparisonDigest({ ...task, execution: { kind: "local" } })).toBe(
      local,
    );
    const isolated = comparisonDigest({
      ...task,
      execution: { kind: "docker", image },
    });
    expect(isolated).not.toBe(local);
    expect(
      comparisonDigest({
        ...task,
        execution: { kind: "docker", image: `node@sha256:${"b".repeat(64)}` },
      }),
    ).not.toBe(isolated);
  });

  it("builds a fixed non-root, offline, resource-limited container without host metadata mounts", () => {
    const args = containerCreateArguments(
      image,
      "agent-eval-test",
      "agent-eval-test-workspace",
      1001,
      1001,
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--user",
        "1001:1001",
        "--memory",
        "536870912",
        "--memory-swap",
        "536870912",
        "--pids-limit",
        "128",
        "--pull",
        "never",
        "--init",
        "--no-healthcheck",
        "--log-driver",
        "none",
      ]),
    );
    expect(args.filter((arg) => arg.startsWith("type=volume"))).toEqual([
      "type=volume,source=agent-eval-test-workspace,target=/workspace,volume-nocopy",
    ]);
    expect(args.some((arg) => arg.startsWith("type=bind"))).toBe(false);
    expect(args).toContain(
      "/tmp:rw,noexec,nosuid,nodev,size=67108864,nr_inodes=4096,mode=1777",
    );
    expect(args).not.toContain("--privileged");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(() =>
      containerCreateArguments(image, "test", "/tmp/path,extra", 1001, 1001),
    ).toThrow("volume name");
    expect(() =>
      containerCreateArguments(image, "test", "/tmp/path", 0, 0),
    ).toThrow("non-root");
  });

  it("refuses daemon-resolved settings that weaken the fixed policy", () => {
    const resolved = {
      Image: "sha256:resolved",
      Config: {
        User: "1001:1001",
        Labels: { "agent-eval-runner": "agent-eval-test-workspace" },
        Entrypoint: ["/usr/local/bin/node"],
        Cmd: ["-e", "setInterval(() => {}, 1000)"],
        Healthcheck: { Test: ["NONE"] },
      },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges=true"],
        Memory: 536870912,
        MemorySwap: 536870912,
        NanoCpus: 1000000000,
        PidsLimit: 128,
        PidMode: "",
        IpcMode: "private",
        Init: true,
        LogConfig: { Type: "none" },
        RestartPolicy: { Name: "no" },
        Mounts: [
          {
            Type: "volume",
            Source: "agent-eval-test-workspace",
            Target: "/workspace",
            ReadOnly: false,
            VolumeOptions: { NoCopy: true },
          },
        ],
        Binds: null,
        Tmpfs: {
          "/tmp":
            "rw,noexec,nosuid,nodev,size=67108864,nr_inodes=4096,mode=1777",
        },
      },
      Mounts: [
        {
          Type: "volume",
          Name: "agent-eval-test-workspace",
          Driver: "local",
          Destination: "/workspace",
          RW: true,
        },
      ],
    };
    const verify = (value: unknown) => {
      assertContainerPolicy(
        value,
        "agent-eval-test-workspace",
        1001,
        1001,
        resolved.Image,
      );
    };
    expect(() => {
      verify(resolved);
    }).not.toThrow();
    expect(() => {
      verify({
        ...resolved,
        HostConfig: {
          ...resolved.HostConfig,
          Mounts: resolved.HostConfig.Mounts.map((mount) => ({
            Type: mount.Type,
            Source: mount.Source,
            Target: mount.Target,
            VolumeOptions: mount.VolumeOptions,
          })),
        },
      });
    }).not.toThrow();
    expect(() => {
      assertContainerPolicy(
        resolved,
        "agent-eval-test-workspace",
        1001,
        1001,
        resolved.Image,
        true,
      );
    }).toThrow("fixed execution policy");
    expect(() => {
      assertContainerPolicy(
        {
          ...resolved,
          HostConfig: {
            ...resolved.HostConfig,
            Mounts: resolved.HostConfig.Mounts.map((mount) => ({
              ...mount,
              ReadOnly: true,
            })),
          },
          Mounts: resolved.Mounts.map((mount) => ({ ...mount, RW: false })),
        },
        "agent-eval-test-workspace",
        1001,
        1001,
        resolved.Image,
        true,
      );
    }).not.toThrow();
    for (const weakened of [
      { ...resolved, Config: { User: "0:0" } },
      { ...resolved, Config: { ...resolved.Config, Labels: {} } },
      { ...resolved, Image: "another-image" },
      {
        ...resolved,
        Mounts: [...resolved.Mounts, { Type: "bind", Source: "/" }],
      },
      ...[
        { NetworkMode: "host" },
        { ReadonlyRootfs: false },
        { Privileged: true },
        { CapDrop: [] },
        { SecurityOpt: [] },
        { Memory: 0 },
        { PidsLimit: 0 },
        { Binds: ["/:/host"] },
        { LogConfig: { Type: "json-file" } },
        { RestartPolicy: { Name: "always" } },
        {
          Mounts: [
            {
              ...resolved.HostConfig.Mounts[0],
              VolumeOptions: { NoCopy: false },
            },
          ],
        },
      ].map((override) => ({
        ...resolved,
        HostConfig: { ...resolved.HostConfig, ...override },
      })),
    ])
      expect(() => {
        verify(weakened);
      }).toThrow("fixed execution policy");
  });

  it.runIf(process.platform !== "linux")(
    "preserves a failed unsupported-runtime attempt instead of falling back to host commands",
    async () => {
      const repository = await createTestRepository();
      const task = {
        ...batchFor(repository).task,
        execution: { kind: "docker", image },
        adapter: { kind: "fake", actions: [] },
      };
      const result = await runEvaluation(parseTaskSpec(task));
      expect(result.status).toBe("failed");
      expect(result.execution).toMatchObject({
        kind: "docker",
        imageId: null,
        cleanup: "not_created",
      });
      expect(result.commands).toEqual([]);
      expect(result.checks).toMatchObject([
        { status: "skipped", reason: "execution_failed" },
      ]);
      expect(result.errors.join(" ")).toContain("requires a Linux runner");
      expect(result.events.map(({ type }) => type)).not.toContain(
        "agent.started",
      );
    },
  );
});
