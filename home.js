
const handler = async (event, context) => {
  console.log(event);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html',
    },
    body: '<html><body>This is the placeholder homepage for the PR Linked Issues GitHub App by Edward Browncross.</body></html>',
  };
};

module.exports.handler = handler;