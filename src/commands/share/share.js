const inputUtil = require("../../shared/inputUtil");
const githubUtil = require("../../shared/githubUtil");
const settingsUtil = require("../../shared/settingsUtil");
const templateAnatomy = require("../../shared/templateAnatomy.json");
const baseTemplate = require("../../shared/baseFile.json");
const parser = require("../../shared/parser");
const flatten = require("flat");
const fs = require("fs");
const path = require("path");

const { Separator } = require("inquirer");
const { unflatten } = require("flat");

const templateType = "SAM"; // so far only supports SAM
async function run(cmd) {
  if (!fs.existsSync(cmd.template)) {
    console.log(
      `Can't find ${cmd.template}. Use -t option to specify template filename`
    );
  }
  const template = parser.parse("own", fs.readFileSync(cmd.template));
  const choices = [];
  for (const block of Object.keys(templateAnatomy[templateType]).filter(
    (p) => templateAnatomy[templateType][p].sharable
  )) {
    if (!template[block]) continue;
    choices.push(new Separator(`*** ${block} ***`));
    for (const item of Object.keys(template[block] || [])) {
      choices.push({
        name: `${item} ${
          template[block][item].Type ? `[${template[block][item].Type}]` : ""
        }`,
        value: { block, item },
      });
    }
  }

  const items = await inputUtil.checkbox(
    "Select components(s) making up your pattern",
    choices
  );
  let sharedTemplate = {};
  for (const item of items) {
    sharedTemplate[item.block] = sharedTemplate[item.block] || {};
    sharedTemplate[item.block][item.item] = template[item.block][item.item];
  }
  let item;
  const metadata = {
    PatternTransform: {
      Properties: [],
      Placeholders: [],
    },
  };
  let resources = Object.keys(sharedTemplate.Resources);

  for(const resourceIndex in resources) {
    const resource = resources[resourceIndex];
    const words = resource.split(/(?=[A-Z])/);     
    const list = ["No change needed"];
    let string = ""
    for(const word of words) {
      string += word;
      list.push(string);
    }
    const dynamic = await inputUtil.list(`Select dynamic value for ${resource}`, list);
    if (dynamic === "No change needed")
      continue;
    const placeholderName = await inputUtil.text(`Name placeholder for ${dynamic}`, dynamic);
    const message = await inputUtil.text("Set prompt for user:", `Set value for '${placeholderName}' placeholder`, `Set value for ${placeholderName}`)
    sharedTemplate = JSON.parse(JSON.stringify(sharedTemplate).replace(new RegExp(dynamic, "g"), placeholderName));
    metadata.PatternTransform.Placeholders.push({Placeholder: placeholderName, message});
    resources = resources.map(p=>p.replace(new RegExp(dynamic, "g"), placeholderName));
  }

  do {
    const paths = flatten(sharedTemplate);
    item = await inputUtil.list("Select item to modify", [
      ...Object.keys(paths).map((p) => {
        return { name: `${p}: ${paths[p]}`, value: p };
      }),
      "Done",
    ]);
    if (item === "Done") break;
    const action = await inputUtil.list("Select action", [
      "Set default value",
      "Make customisable",
      "Delete",
    ]);
    if (action === "Delete") {
      delete paths[item];
    }
    if (action === "Make customisable") {
      const message = await inputUtil.text("Prompt message");
      metadata.PatternTransform.Properties.push({
        JSONPath: "$." + item,
        Message: message,
        InputType: typeof paths[item],
      });
    }
    if (action === "Set default value") {
      paths[item] = await inputUtil.text("Set new value", paths[item]);
    }

    sharedTemplate = unflatten(paths);
  } while (true);

  sharedTemplate.Metadata = metadata;
  sharedTemplate = { ...baseTemplate, ...sharedTemplate };
  sharedTemplate = Object.keys(sharedTemplate)
    .sort(
      (a, b) =>
        templateAnatomy[templateType][a].order -
        templateAnatomy[templateType][b].order
    )
    .reduce((obj, key) => {
      obj[key] = sharedTemplate[key];
      return obj;
    }, {});
  const name = await inputUtil.text(
    "Pattern name:",
    Object.keys(sharedTemplate.Resources)
      .map((p) => resourceShortName(sharedTemplate.Resources[p].Type))
      .join("-")
  );

  const sources = settingsUtil.get();
  const repo = await inputUtil.list(
    "Select repository",
    sources.map((p) => {
      return { name: `${p.owner}/${p.repo}`, value: p };
    })
  );
  repo.branch = repo.branch || "main";
  try {
    await githubUtil.putContent(
      repo.owner,
      repo.repo,
      repo.branch,
      path.join(repo.root, name, repo.relativePath, repo.fileNames[0]),
      parser.stringify("yaml", sharedTemplate)
    );
    console.log(
      `Pattern pushed. Please consider describing the pattern in the README: https://github.com/${repo.owner}/${repo.repo}/edit/${repo.branch}${repo.root}${name}${repo.relativePath}README.md`
    );
  } catch (err) {
    console.log(err.message);
    console.log(
      "Make sure your GITHUB_TOKEN has sufficient permissions to push to this repository"
    );
  }
}

function resourceShortName(type) {
  switch (type) {
    case "AWS::Serverless::Api":
      return "lambda";
    case "AWS::Serverless::Application":
      return "sar";
    case "AWS::Serverless::HttpApi":
      return "httpapi";
    case "AWS::Serverless::LayerVersion":
      return "layer";
    case "AWS::Serverless::SimpleTable":
      return "dynamodb";
    case "AWS::Serverless::StateMachine":
      return "stepfunctions";
    case "AWS::Serverless::Function":
      return "lambda";
    case "AWS::Events::Rule":
      return "eventbridge";
    default:
      return type.split("::")[1].toLowerCase();
  }
}

module.exports = {
  run,
};
