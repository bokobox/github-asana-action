import type { components } from "./asana-openapi-schema";
import { ApiClient, UsersApi, TasksApi, SectionsApi, StoriesApi } from "asana";

const Asana = require("asana");
const core = require("@actions/core");
const github = require("@actions/github");
type AsanaSchemas = components["schemas"];

async function moveSection(taskId: string, targets) {
  const tasksClient = new Asana.TasksApi() as TasksApi;
  const task = (
    await tasksClient.getTask(taskId, {
      opt_fields: "projects.name",
    })
  ).data as AsanaSchemas["TaskResponse"];

  const sectionClient = new Asana.SectionsApi() as SectionsApi;

  targets.forEach(async (target) => {
    const targetProject = task.projects.find((project) =>
      target.project
        ? project.name === target.project
        : project.gid === target.project_id
    );
    if (!targetProject) {
      core.info(`This task does not exist in "${target.project}" project`);
      return;
    }
    const sections = (
      await sectionClient.getSectionsForProject(targetProject.gid, {})
    ).data as AsanaSchemas["SectionCompact"][];
    let targetSection = sections.find(
      (section) => section.name === target.section
    );
    if (targetSection) {
      const data: AsanaSchemas["SectionTaskInsertRequest"] = {
        task: taskId,
      };
      await sectionClient.addTaskForSection(targetSection.gid, {
        body: { data },
      });
      core.info(`Moved to: ${target.project}/${target.section}`);
    } else {
      core.error(`Asana section ${target.section} not found.`);
    }
  });
}

async function findComment(
  taskId,
  commentId
): Promise<AsanaSchemas["StoryCompact"] | undefined> {
  const storiesClient = new Asana.StoriesApi() as StoriesApi;

  const stories = (await storiesClient.getStoriesForTask(taskId, {}))
    .data as AsanaSchemas["StoryCompact"][];
  return stories.find((story) => story.text.indexOf(commentId) !== -1);
}

async function addComment(
  taskId,
  commentId,
  text,
  isPinned
): Promise<AsanaSchemas["StoryResponse"]> {
  if (commentId) {
    text += "\n" + commentId + "\n";
  }
  const storiesClient = new Asana.StoriesApi() as StoriesApi;
  try {
    const data: AsanaSchemas["StoryRequest"] = {
      text: text,
      is_pinned: isPinned,
    };
    const comment = (
      await storiesClient.createStoryForTask({ data }, taskId, {})
    ).data as AsanaSchemas["StoryResponse"];
    return comment;
  } catch (error) {
    console.error("rejecting promise", error);
  }
}

async function buildClient(asanaPAT): Promise<string | null> {
  let client = Asana.ApiClient.instance;
  let token = client.authentications["token"];
  token.accessToken = asanaPAT;

  let usersApiInstance = new Asana.UsersApi() as UsersApi;
  // Get your user info
  try {
    const result = (await usersApiInstance.getUser("me", {}))
      .data as AsanaSchemas["UserResponse"];
    return result?.gid ?? null;
  } catch (error) {
    return null;
  }
}

async function action() {
  const ASANA_PAT = core.getInput("asana-pat", { required: true }),
    ACTION = core.getInput("action", { required: true }),
    TRIGGER_PHRASE = core.getInput("trigger-phrase") || "",
    PULL_REQUEST = github.context.payload.pull_request,
    REGEX_STRING = `${TRIGGER_PHRASE}(?:\s*)https:\\/\\/app.asana.com\\/(\\d+)\\/(?<project>\\d+)\\/(?<task>\\d+)`,
    REGEX = new RegExp(REGEX_STRING, "g");
  console.log("pull_request", PULL_REQUEST);

  const client = await buildClient(ASANA_PAT);
  if (client === null) {
    throw new Error("client authorization failed");
  }

  console.info("looking in body", PULL_REQUEST?.body, "regex", REGEX_STRING);
  let foundAsanaTasks: string[] = [];
  let parseAsanaURL: RegExpExecArray | null;
  while ((parseAsanaURL = REGEX.exec(PULL_REQUEST?.body ?? "")) !== null) {
    const taskId = parseAsanaURL.groups?.task;
    if (!taskId) {
      core.error(
        `Invalid Asana task URL after the trigger phrase ${TRIGGER_PHRASE}`
      );
      continue;
    }
    foundAsanaTasks.push(taskId);
  }
  console.info(
    `found ${foundAsanaTasks.length} taskIds:`,
    foundAsanaTasks.join(",")
  );

  console.info("calling", ACTION);
  switch (ACTION) {
    case "assert-link": {
      const githubToken = core.getInput("github-token", { required: true });
      const linkRequired =
        core.getInput("link-required", { required: true }) === "true";
      const octokit = github.getOctokit(githubToken);
      const statusState =
        !linkRequired || foundAsanaTasks.length > 0 ? "success" : "error";
      core.info(
        `setting ${statusState} for ${github.context.payload.pull_request.head.sha}`
      );
      octokit.rest.repos.createStatus({
        ...github.context.repo,
        context: "asana-link-presence",
        state: statusState,
        description: "asana link not found",
        sha: github.context.payload.pull_request.head.sha,
      });
      break;
    }
    case "add-comment": {
      const commentId = core.getInput("comment-id"),
        htmlText = core.getInput("text", { required: true }),
        isPinned = core.getInput("is-pinned") === "true";
      const comments = [];
      for (const taskId of foundAsanaTasks) {
        if (commentId) {
          const comment = await findComment(taskId, commentId);
          if (comment) {
            console.info("found existing comment", comment.gid);
            continue;
          }
        }
        const comment = await addComment(taskId, commentId, htmlText, isPinned);
        comments.push(comment);
      }
      return comments;
    }
    case "remove-comment": {
      const commentId = core.getInput("comment-id", { required: true });
      const removedCommentIds = [];
      for (const taskId of foundAsanaTasks) {
        const comment = await findComment(taskId, commentId);
        if (comment) {
          console.info("removing comment", comment.gid);
          const storiesClient = new Asana.StoriesApi() as StoriesApi;
          try {
            await storiesClient.deleteStory(comment.gid);
          } catch (error) {
            console.error("rejecting promise", error);
          }
          removedCommentIds.push(comment.gid);
        }
      }
      return removedCommentIds;
    }
    case "complete-task": {
      const isComplete = core.getInput("is-complete") === "true";
      const taskIds = [];
      for (const taskId of foundAsanaTasks) {
        console.info(
          "marking task",
          taskId,
          isComplete ? "complete" : "incomplete"
        );
        try {
          const tasksClient = new Asana.TasksApi() as TasksApi;
          const data: AsanaSchemas["TaskRequest"] = {
            completed: isComplete,
          };
          await tasksClient.updateTask({ data }, taskId, {});
        } catch (error) {
          console.error("rejecting promise", error);
        }
        taskIds.push(taskId);
      }
      return taskIds;
    }
    case "move-section": {
      const targetJSON = core.getInput("targets", { required: true });
      const targets = JSON.parse(targetJSON);
      const movedTasks = [];
      for (const taskId of foundAsanaTasks) {
        await moveSection(taskId, targets);
        movedTasks.push(taskId);
      }
      return movedTasks;
    }
    default:
      core.setFailed("unexpected action ${ACTION}");
  }
}

module.exports = {
  action,
  default: action,
  buildClient: buildClient,
};
