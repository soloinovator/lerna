import {
  Arguments,
  Command,
  CommandConfigOptions,
  promptConfirmation,
  pulseTillDone,
  ValidationError,
} from "@lerna/core";
import { ExecOptions } from "child_process";
import dedent from "dedent";
import fs from "fs-extra";
import pMapSeries from "p-map-series";
import path from "path";

const childProcess = require("@lerna/child-process");

export function factory(argv: Arguments<ImportCommandOptions>) {
  return new ImportCommand(argv);
}

interface ImportCommandOptions extends CommandConfigOptions {
  dir?: string;
  dest?: string;
  flatten?: boolean;
  preserveCommit?: boolean;
  yes?: boolean;
}

export class ImportCommand extends Command<ImportCommandOptions> {
  private externalExecOpts: ExecOptions = { cwd: "" };
  private targetDirRelativeToGitRoot?: string;
  private commits: string[] = [];
  private origGitEmail?: string;
  private origGitName?: string;
  private preImportHead?: string;

  gitParamsForTargetCommits() {
    const params = ["log", "--format=%h"];
    if (this.options.flatten) {
      params.push("--first-parent");
    }
    return params;
  }

  override initialize() {
    const inputPath = this.options.dir;

    const externalRepoPath = path.resolve(inputPath ?? "");
    const externalRepoBase = path.basename(externalRepoPath);

    this.externalExecOpts = Object.assign({}, this.execOpts, {
      cwd: externalRepoPath,
    });

    let stats;

    try {
      stats = fs.statSync(externalRepoPath);
    } catch (e: any) {
      if (e.code === "ENOENT") {
        throw new ValidationError("ENOENT", `No repository found at "${inputPath}"`);
      }

      throw e;
    }

    if (!stats.isDirectory()) {
      throw new ValidationError("ENODIR", `Input path "${inputPath}" is not a directory`);
    }

    const packageJson = path.join(externalRepoPath, "package.json");

    const packageName = require(packageJson).name;

    if (!packageName) {
      throw new ValidationError("ENOPKG", `No package name specified in "${packageJson}"`);
    }

    // Compute a target directory relative to the Lerna root
    const targetBase = this.getTargetBase();
    if (this.getPackageDirectories().indexOf(targetBase) === -1) {
      throw new ValidationError(
        "EDESTDIR",
        `--dest does not match with the package directories: ${this.getPackageDirectories()}`
      );
    }
    const targetDir = path.join(targetBase, externalRepoBase);

    // Compute a target directory relative to the Git root
    const gitRepoRoot = this.getWorkspaceRoot();
    const lernaRootRelativeToGitRoot = path.relative(gitRepoRoot, this.project.rootPath);
    this.targetDirRelativeToGitRoot = path.join(lernaRootRelativeToGitRoot, targetDir);

    //if the target directory is not in the Git root
    if (this.targetDirRelativeToGitRoot.startsWith("..")) {
      throw new ValidationError(
        "ENOTINREPO",
        `Project root ${this.project.rootPath} is not a subdirectory of git root ${gitRepoRoot}`
      );
    }

    if (fs.existsSync(path.resolve(this.project.rootPath, targetDir))) {
      throw new ValidationError("EEXISTS", `Target directory already exists "${targetDir}"`);
    }

    this.commits = this.externalExecSync("git", this.gitParamsForTargetCommits()).split("\n").reverse();
    // this.commits = this.externalExecSync("git", [
    //   "rev-list",
    //   "--no-merges",
    //   "--topo-order",
    //   "--reverse",
    //   "HEAD",
    // ]).split("\n");

    if (!this.commits.length) {
      throw new ValidationError("NOCOMMITS", `No git commits to import at "${inputPath}"`);
    }

    if (this.options.preserveCommit) {
      // Back these up since they'll change for each commit
      this.origGitEmail = this.execSync("git", ["config", "user.email"]);
      this.origGitName = this.execSync("git", ["config", "user.name"]);
    }

    // Stash the repo's pre-import head away in case something goes wrong.
    this.preImportHead = this.getCurrentSHA();

    if (this.execSync("git", ["diff-index", "HEAD"])) {
      throw new ValidationError("ECHANGES", "Local repository has un-committed changes");
    }

    this.logger.info(
      "",
      `About to import ${this.commits.length} commits from ${inputPath} into ${targetDir}`
    );

    if (this.options.yes) {
      return true;
    }

    return promptConfirmation("Are you sure you want to import these commits onto the current branch?");
  }

  getPackageDirectories() {
    return this.project.packageConfigs.filter((p) => p.endsWith("*")).map((p) => path.dirname(p));
  }

  getTargetBase() {
    if (this.options.dest) {
      return this.options.dest;
    }

    return this.getPackageDirectories().shift() || "packages";
  }

  getCurrentSHA() {
    return this.execSync("git", ["rev-parse", "HEAD"]);
  }

  getWorkspaceRoot() {
    return this.execSync("git", ["rev-parse", "--show-toplevel"]);
  }

  execSync(cmd: string, args: string[]): string {
    return childProcess.execSync(cmd, args, this.execOpts);
  }

  externalExecSync(cmd: string, args: string[]): string {
    return childProcess.execSync(cmd, args, this.externalExecOpts);
  }

  createPatchForCommit(sha: string) {
    let patch = null;

    if (this.options.flatten) {
      const diff = this.externalExecSync("git", [
        "log",
        "--reverse",
        "--first-parent",
        "-p",
        "-m",
        "--pretty=email",
        "--stat",
        "--binary",
        "-1",
        "--color=never",
        sha,
        // custom git prefixes for accurate parsing of filepaths (#1655)
        `--src-prefix=COMPARE_A/`,
        `--dst-prefix=COMPARE_B/`,
      ]);
      const version = this.externalExecSync("git", ["--version"]).replace(/git version /g, "");

      patch = `${diff}\n--\n${version}`;
    } else {
      patch = this.externalExecSync("git", [
        "format-patch",
        "-1",
        sha,
        "--stdout",
        // custom git prefixes for accurate parsing of filepaths (#1655)
        `--src-prefix=COMPARE_A/`,
        `--dst-prefix=COMPARE_B/`,
      ]);
    }

    const formattedTarget = this.targetDirRelativeToGitRoot?.replace(/\\/g, "/");
    const replacement = `$1/${formattedTarget}`;

    // Create a patch file for this commit and prepend the target directory
    // to all affected files.  This moves the git history for the entire
    // external repository into the package subdirectory, commit by commit.
    return patch
      .replace(/^([-+]{3} "?COMPARE_[AB])/gm, replacement)
      .replace(/^(diff --git "?COMPARE_A)/gm, replacement)
      .replace(/^(diff --git (?! "?COMPARE_B\/).+ "?COMPARE_B)/gm, replacement)
      .replace(/^(copy (from|to)) ("?)/gm, `$1 $3${formattedTarget}/`)
      .replace(/^(rename (from|to)) ("?)/gm, `$1 $3${formattedTarget}/`);
  }

  getGitUserFromSha(sha: string) {
    return {
      email: this.externalExecSync("git", ["show", "-s", "--format='%ae'", sha]),
      name: this.externalExecSync("git", ["show", "-s", "--format='%an'", sha]),
    };
  }

  configureGitUser({ email, name }: { email?: string; name?: string }) {
    this.execSync("git", ["config", "user.email", `"${email}"`]);
    this.execSync("git", ["config", "user.name", `"${name}"`]);
  }

  override execute() {
    this.enableProgressBar();

    const tracker = this.logger["newItem"]("execute");
    const mapper = (sha: string) => {
      tracker.info(sha);

      const patch = this.createPatchForCommit(sha);
      const procArgs = ["am", "-3", "--keep-non-patch"];

      if (this.options.preserveCommit) {
        this.configureGitUser(this.getGitUserFromSha(sha));
        procArgs.push("--committer-date-is-author-date");
      }

      // Apply the modified patch to the current lerna repository, preserving
      // original commit date, author and message.
      //
      // Fall back to three-way merge, which can help with duplicate commits
      // due to merge history.
      const proc = childProcess.exec("git", procArgs, this.execOpts);

      proc.stdin.end(patch);

      return pulseTillDone(proc)
        .then(() => {
          tracker.completeWork(1);
        })
        .catch((err: any) => {
          // Getting commit diff to see if it's empty
          const diff = this.externalExecSync("git", ["diff", "-s", `${sha}^!`]).trim();
          if (diff === "") {
            tracker.completeWork(1);

            // Automatically skip empty commits
            return childProcess.exec("git", ["am", "--skip"], this.execOpts);
          }

          err.sha = sha;
          throw err;
        });
    };

    tracker.addWork(this.commits.length);

    return pMapSeries(this.commits, mapper)
      .then(() => {
        tracker.finish();

        if (this.options.preserveCommit) {
          this.configureGitUser({
            email: this.origGitEmail,
            name: this.origGitName,
          });
        }

        this.logger.success("import", "finished");
      })
      .catch((err) => {
        tracker.finish();

        if (this.options.preserveCommit) {
          this.configureGitUser({
            email: this.origGitEmail,
            name: this.origGitName,
          });
        }

        this.logger.error("import", `Rolling back to previous HEAD (commit ${this.preImportHead})`);

        // Abort the failed `git am` and roll back to previous HEAD.
        this.execSync("git", ["am", "--abort"]);
        if (this.preImportHead) {
          this.execSync("git", ["reset", "--hard", this.preImportHead]);
        }
        throw new ValidationError(
          "EIMPORT",
          dedent`
            Failed to apply commit ${err.sha}.
            ${err.message}

            You may try again with --flatten to import flat history.
          `
        );
      });
  }
}
