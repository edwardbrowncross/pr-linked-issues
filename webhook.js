const fs = require('fs');
const jwt = require('jsonwebtoken');
const Octokit = require('@octokit/rest');
const AWS = require('aws-sdk');
const crypto = require('crypto');

const GITHUB_APP_ID = parseInt(process.env.GITHUB_APP_ID);
const GITHUB_APP_NAME = process.env.GITHUB_APP_NAME;
const SSM_APP_CERTIFICATE = process.env.SSM_APP_CERTIFICATE;
const SSM_APP_SECRET = process.env.SSM_APP_SECRET;
const DOMAIN_NAME = process.env.DOMAIN_NAME;

const ssm = new AWS.SSM();

const certPromise = ssm
  .getParameter({
    Name: SSM_APP_CERTIFICATE,
    WithDecryption: true,
  })
  .promise()
  .then(p => Buffer.from(p.Parameter.Value, 'utf8'));

const secretPromise = ssm
  .getParameter({
    Name: SSM_APP_SECRET,
    WithDecryption: true,
  })
  .promise()
  .then(p => Buffer.from(p.Parameter.Value, 'utf8'));

const checkValidity = async ({ body, headers }) => {
  if (!headers['X-Hub-Signature']) {
    return false;
  }
  const secret = await secretPromise;
  const [algorithm, checkHash] = headers['X-Hub-Signature'].split('=');

  const hash = crypto
    .createHmac(algorithm, secret)
    .update(body)
    .digest('hex');
  console.log({ checkHash, hash });
  return hash === checkHash;
} 

const getAccessToken = async (installationId) => {
  const now = Math.floor(Date.now()/1000);
  const cert = await certPromise;
  const bearer = jwt.sign({
    iat: now,
    exp: now + 300,
    iss: GITHUB_APP_ID,
  }, cert, { algorithm: 'RS256' });
  
  const octokit = new Octokit({ auth: `bearer ${bearer}` });
  const { data: { token } } = await octokit.apps.createInstallationToken({ installation_id: installationId });
  return token;
};

const getIssues = body => {
  const issueRegex = /#(\d+)/g;
  let issues = [];
  let match;
  while (match = issueRegex.exec(body)) {
    issues.push(parseInt(match[1]));
  }
  return issues;
};

const getPendingStatusParams = () => ({
  state: 'pending',
  context: GITHUB_APP_NAME,
});

const getStatusParams = passes => ({
  state: passes ? 'success' : 'failure',
  target_url: `https://${DOMAIN_NAME}`,
  description: passes
    ? 'Pull Request is linked to an issue'
    : 'Pull Request must be linked to at least one open issue from this repository',
  context: GITHUB_APP_NAME,
});

const somePromise = (promises, fn) => {
  return new Promise((resolve, reject) => {
    promises.map(p => p.then(result => fn(result) ? resolve(true) : null));
    Promise.all(promises).then(() => resolve(false), reject);
  });
};

const isIssueValid = result =>
  result && result.status === 200 && result.data.state === 'open' && !result.data.pull_request;

const handler = async (event, context) => {
  const { pull_request: pullRequest, action, installation, repository } = JSON.parse(event.body);
  const { title, body, head: { sha } } = pullRequest;
  const [owner, repo] = repository.full_name.split('/');
  const installationId = installation.id;
  
  console.log({ msg: 'Handling webhook', action, title, body, installationId });

  const valid = await checkValidity(event);

  if (!valid) {
    return { statusCode: 400, body: 'invalid signature' };
  }
  
  const token = await getAccessToken(installationId);
  console.log({ msg: 'Got access token' });

  const octokit = new Octokit({ auth: `token ${token}` });

  await octokit.repos.createStatus({
    owner, repo, sha,
    ...getPendingStatusParams(),
  });

  console.log({ msg: 'Set pending status' });

  try {
    const issues = getIssues(`${title} ${body}`);

    console.log({ msg: 'Found issues', numIssues: issues.length, issues: issues });

    const passes = await somePromise(
      issues.map(number =>
        octokit.issues.get({ owner, repo, number })
          .catch(err => false)),
      isIssueValid,
    );

    console.log({ msg: 'Issues checked', passes });

    await octokit.repos.createStatus({
      owner, repo, sha,
      ...getStatusParams(passes),
    });

    console.log({ msg: 'Set final status' });
  
    return { statusCode: 200 };
  } catch (err) {
    console.log({ msg: 'An error occurred', err });
    return { statusCode: 500 };
  }
};

module.exports.handler = handler;