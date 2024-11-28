import type { components } from "./asana-openapi-schema";
import {
  UsersApi,
  TasksApi,
  SectionsApi,
  StoriesApi,
  CustomFieldSettingsApi,
} from "asana";

const Asana = require("asana");
const core = require("@actions/core");
const github = require("@actions/github");
type AsanaSchemas = components["schemas"];

async function moveSection(taskId: string, targets: any[]) {
  const tasksClient = new Asana.TasksApi() as TasksApi;
  const task = (
    await tasksClient.getTask(taskId, {
      opt_fields: "projects.name",
    })
  ).data as AsanaSchemas["TaskResponse"];

  const sectionClient = new Asana.SectionsApi() as SectionsApi;

  targets.forEach(async (target) => {
    const targetProject = task.projects?.find((project) =>
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

async function updateFields(
  taskId: string,
  isComplete: boolean | undefined,
  targets: any[]
) {
  const tasksClient = new Asana.TasksApi() as TasksApi;
  const task = (
    await tasksClient.getTask(taskId, {
      opt_fields: "projects.name",
    })
  ).data as AsanaSchemas["TaskResponse"];

  const customFieldSettingsClient =
    new Asana.CustomFieldSettingsApi() as CustomFieldSettingsApi;

  targets.forEach(async (target) => {
    const targetProject = task.projects?.find((project) =>
      target.project
        ? project.name === target.project
        : project.gid === target.project_id
    );
    if (!targetProject) {
      core.info(`This task does not exist in "${target.project}" project`);
      return;
    }
    const customFields = (
      await customFieldSettingsClient.getCustomFieldSettingsForProject(
        targetProject.gid,
        {}
      )
    ).data as AsanaSchemas["CustomFieldSettingResponse"][];

    const fields = target.fields as any[];
    if (!fields) {
      core.info(`No fields to update for ${target.project}`);
      return;
    }
    let fieldsToUpdate: AsanaSchemas["TaskRequest"]["custom_fields"] = {};
    fields.forEach(async (targetField: any) => {
      let targetCustomField = customFields.find((field) =>
        targetField.name
          ? field.custom_field?.name === targetField.name
          : field.custom_field?.gid === targetField.id
      );
      const customField = targetCustomField?.custom_field;
      const fieldId = targetCustomField?.custom_field;
      if (customField && customField.gid && customField.resource_subtype) {
        const euumOptions = new Map(
          customField.enum_options?.map((option) => [option.name, option.gid])
        );
        switch (customField.resource_subtype) {
          case "enum":
            if (!euumOptions.has(targetField.value)) {
              core.error(
                `Asana custom field enum value ${target.value} not found in ${targetField.name} field.`
              );
              break;
            }
            fieldsToUpdate[customField.gid] =
              euumOptions.get(targetField.value) ?? "";
            break;
          case "multi_enum":
            let enumValues = targetField.value as string[];
            enumValues = enumValues.map((value) => {
              if (!euumOptions.has(value)) {
                core.error(
                  `Asana custom field enum value ${value} not found in ${targetField.name} field.`
                );
                return "";
              }
              return euumOptions.get(value) ?? "";
            });
            fieldsToUpdate[customField.gid] = enumValues as any;
            break;
          default:
            fieldsToUpdate[customField.gid] = targetField.value;
            break;
        }
      } else {
        core.error(`Asana custom field ${targetField.name} not found.`);
      }
    });

    const data: AsanaSchemas["TaskRequest"] = {
      custom_fields: fieldsToUpdate,
      completed: isComplete,
    };
    await tasksClient.updateTask({ data }, taskId, {});
    core.info(`Updated: ${JSON.stringify(fields)}`);
  });
}

async function findComment(
  taskId: string,
  commentId: string
): Promise<AsanaSchemas["StoryCompact"] | undefined> {
  const storiesClient = new Asana.StoriesApi() as StoriesApi;

  const stories = (await storiesClient.getStoriesForTask(taskId, {}))
    .data as AsanaSchemas["StoryCompact"][];
  return stories.find(
    (story) => story.text && story.text.indexOf(commentId) !== -1
  );
}

async function addComment(
  taskId: string,
  commentId: string,
  text: string,
  isPinned: boolean
): Promise<AsanaSchemas["StoryResponse"] | undefined> {
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

export async function buildClient(asanaPAT: string): Promise<string | null> {
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

export async function action() {
  const ASANA_PAT = core.getInput("asana-pat", { required: true }),
    ACTION = core.getInput("action", { required: true }),
    TRIGGER_PHRASE = core.getInput("trigger-phrase") || "",
    PULL_REQUEST = github.context.payload.pull_request,
    REGEX_STRING = `${TRIGGER_PHRASE}(?:\s*)https:\\/\\/app.asana.com\\/(\\d+)\\/(?<project>\\d+)\\/(?<task>\\d+)`,
    REGEX = new RegExp(REGEX_STRING, "g");

  const client = await buildClient(ASANA_PAT);
  if (client === null) {
    throw new Error("client authorization failed");
  }

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
      const octokit = new github.GitHub(githubToken);
      const statusState =
        !linkRequired || foundAsanaTasks.length > 0 ? "success" : "error";
      core.info(
        `setting ${statusState} for ${github.context.payload.pull_request.head.sha}`
      );
      octokit.repos.createStatus({
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
    case "update-fields": {
      const isCompleteString = core.getInput("is-complete");
      const isComplete =
        isCompleteString === "true"
          ? true
          : isCompleteString === "false"
          ? false
          : undefined;
      const targetJSON = core.getInput("targets", { required: true });
      const targets = JSON.parse(targetJSON);
      const updatedTasks = [];
      for (const taskId of foundAsanaTasks) {
        await updateFields(taskId, isComplete, targets);
        updatedTasks.push(taskId);
      }
      return updatedTasks;
    }
    default:
      core.setFailed("unexpected action ${ACTION}");
  }
}

export default action;
