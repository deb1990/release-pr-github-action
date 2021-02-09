const core = require('@actions/core');
const GITHUB_TOKEN = core.getInput('GITHUB_TOKEN');
const github = require('@actions/github');
const _ = require('lodash');
const simpleGit = require('simple-git');
const { execSync } = require('child_process');
const process = require('process');
const dayjs = require('dayjs');
const octokit = github.getOctokit(GITHUB_TOKEN);

var owner, repo;

const BASE_BRANCH = 'master';
const RELEASE_VERSION = core.getInput('VERSION_NAME');
const GITHUB_WORKSPACE = process.env.GITHUB_WORKSPACE;
const REPLACE_COMMANDS = JSON.parse(core.getInput('REPLACE')).commands;
const FILE_UPDATE_COMMIT_DESC = core.getInput('FILE_UPDATE_COMMIT_DESC');
const RELEASE_PR_IDENTIFIER_LABEL = core.getInput('RELEASE_PR_IDENTIFIER_LABEL');
const RELEASE_PR_TITLE = core.getInput('RELEASE_PR_TITLE');
const COMMIT_USERNAME = 'github-actions[bot]';
const COMMIT_USEREMAIL = '<41898282+github-actions[bot]@users.noreply.github.com>';

async function run () {
  try {
    owner = getOwner();
    repo = getRepoName();

    await cloneRepo();

    const lastRelease = await getLastRelease();
    const filteredPullRequests = await getPullRequests(lastRelease)

    if (filteredPullRequests.length === 0 ) {
      throw new Error('No Pull requests has been merged since last release');
    }

    await createReleaseCandidateBranch();
    const pr = await createReleasePR(getReleasePRBody(filteredPullRequests));
    await addLabelToThePR(pr.number);

    console.debug(`Pull Request Created: ${pr.html_url}`);
  } catch (error) {
    core.setFailed(error.message);
  }
}

/**
 * Add Release Label to the RC PR
 *
 * @param {string} prNumber pull request number
 */
async function addLabelToThePR (prNumber) {
  await octokit.issues.update({
    owner,
    repo,
    issue_number: prNumber,
    labels: [RELEASE_PR_IDENTIFIER_LABEL]
  });
}

/**
 * Clone the repository
 */
async function cloneRepo () {
  const REPO_URL = 'https://' + owner + ':' + GITHUB_TOKEN + '@github.com/' + owner + '/' + repo;

  await simpleGit(GITHUB_WORKSPACE)
    .clone(REPO_URL);
}

/**
 * Create Release Candidate Branch with a new Commit
 */
async function createReleaseCandidateBranch () {
  const cwd = GITHUB_WORKSPACE + '/' + repo;

  _.each(REPLACE_COMMANDS, function (cmd) {
    cmd = cmd.replace('<<DATE>>', dayjs().format('YYYY-MM-DD'));
    execSync(cmd, { cwd });
  });

  await simpleGit(cwd)
    .addConfig('user.name', COMMIT_USERNAME)
    .addConfig('user.email', COMMIT_USEREMAIL)
    .checkoutLocalBranch(getRcBranchName())
    .add('./*')
    .commit(FILE_UPDATE_COMMIT_DESC)
    .push('origin', getRcBranchName())
}

/**
 * Create Release Pull Request
 *
 * @param {string} body body of the pr to be created
 * @returns {Promise} newly created pr object
 */
async function createReleasePR (body) {
  var pr = await octokit.pulls.create({
    owner,
    repo,
    title: RELEASE_PR_TITLE,
    head: getRcBranchName(),
    base: BASE_BRANCH,
    body
  });

  return pr.data;
}
/**
 * Get Release Candidate Branch Name
 *
 * @returns {string} branch name
 */
function getRcBranchName () {
  return RELEASE_VERSION + '-rc';
}

/**
 * Get Release Pull Request body content
 *
 * @param {Array} mergedPRs list of merged prs
 * @returns {string} body content
 */
function getReleasePRBody (mergedPRs) {
  const date = dayjs().format('DD MMMM, YYYY');
  var body = `## Release Update - ${date}\n\n### Changelog\n`;

  _.each(mergedPRs, function (pr) {
    body += `\n* ${pr.title} #${pr.number} - @${pr.user}`;
  });

  return body;
}

/**
 * Get Owner Name of Current Repository
 *
 * @returns {string} owner name
 */
function getOwner () {
  const payload = github.context.payload;

  return payload.repository.owner.login;
}

/**
 * Get Current Repository Name
 *
 * @returns {string} repository name
 */
function getRepoName () {
  const payload = github.context.payload;

  return payload.repository.name;
}

/**
 * Get Last Release object as a promise
 *
 * @returns {Promise} last release object
 */
async function getLastRelease () {
  try {
    var release = await octokit.repos.getLatestRelease({
      owner: owner,
      repo: repo
    });

    return release.data;
  } catch (e) {
    return;
  }
}

/**
 * Get all merge Commits between master and sent tag
 *
 * @param {string} tagName name of the tag from last release
 *
 * @returns {Promise} list of commits
 */
async function getMergeCommitsSince (tagName) {
  const cwd = GITHUB_WORKSPACE + '/' + repo;

  var commits = await simpleGit(cwd)
    .log({ from: BASE_BRANCH, to: tagName, '--merges': true });

  return commits.all;
}

/**
 * Get all merge Commits of the repo
 *
 * @returns {Promise} list of commits
 */
async function getAllMergeCommitsSinceBeginning () {
  const cwd = GITHUB_WORKSPACE + '/' + repo;

  var commits = await simpleGit(cwd)
    .log({ from: BASE_BRANCH, '--merges': true });

  // limiting results to 500 prs, as its unlikely to have more prs in a single
  // release. Also if the number is high, it crosses the github api request limit,
  // hence enforcing this limit
  return commits.all.slice(0, 500);
}

/**
 * Get all pull requests
 * If a release exists, it returns PRs merged since last release
 * Otherwise it return all merged PRs
 *
 * @param {object} lastRelease last release object
 *
 * @returns {Promise} list of pull requests
 */
async function getPullRequests (lastRelease) {
  let commits;

  var lastRelease = { tag_name: '1.9.9'};
  if (lastRelease) {
    commits = await getMergeCommitsSince(lastRelease.tag_name);
  } else {
    commits = await getAllMergeCommitsSinceBeginning()
  }

  return await fetchPrsForCommits(commits);
}

/**
 * Fetch all prs for the merge commits
 *
 * @param {Array} commits list of commits
 * @returns {Promise} list of pull requests
 */
async function fetchPrsForCommits (commits) {
  var promises = await _.map(commits, async function (commit) {
    var url = 'GET /repos/' + owner + '/' + repo + '/commits/' + commit.hash + '/pulls';

    var data = await octokit.request(url, {
      owner: owner,
      repo: repo,
      commit_sha: commit.sha,
      mediaType: { previews: ['groot'] }
    });

    return data.data;
  });

  var pullRequests = await Promise.all(promises);

  return _.chain(pullRequests)
    .flatten()
    .filter(function (pr) {
      var ifBelongsToCurrentRepo = pr.base.repo.full_name === owner + '/' + repo;
      var ifPRToMaster = pr.base.ref === BASE_BRANCH;
      var isNotAReleasePr = !_.find(pr.labels, { 'name': RELEASE_PR_IDENTIFIER_LABEL });

      return ifBelongsToCurrentRepo && ifPRToMaster && isNotAReleasePr;
    })
    .map(function (pr) {
      return {
        number: pr.number,
        html_url: pr.html_url,
        user: pr.user.login,
        title: pr.title
      };
    })
    .value();
}

module.exports = run;
