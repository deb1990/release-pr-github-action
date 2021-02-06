const core = require('@actions/core');
const github = require('@actions/github');

async function run () {
  try {
    var GITHUB_TOKEN = core.getInput('GITHUB_TOKEN');
    var octokit = github.getOctokit(GITHUB_TOKEN);

    var pulls = await octokit.request('GET /deb1990/uk.co.compucorp.civicase/pulls');

    console.log(pulls)



    // `who-to-greet` input defined in action metadata file
    const nameToGreet = core.getInput('who-to-greet');
    console.log(`Hello ${nameToGreet}!`);

    // Get the JSON webhook payload for the event that triggered the workflow
    const payload = JSON.stringify(github.context.payload, undefined, 2)
    console.log(`The event payload: ${payload}`);


  } catch (error) {
    core.setFailed(error.message);
  }
};

module.exports = run;
