import * as fs from 'fs';
import * as path from 'path';
import {
  CfnOutput, CustomResource, Duration, AssetStaging,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  custom_resources as cr,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface BashExecFunctionProps {
  /**
   * The path of the shell script to be executed.
   */
  readonly script: string;

  /**
   * The path of your custom dockerfile.
   */
  readonly dockerfile?: string;

  /**
   * Lambda environment variables.
   */
  readonly environment?: { [key: string]: string };

  /**
   * The function execution time (in seconds) after which Lambda terminates the function.
   * Because the execution time affects cost, set this value based on the function's expected execution time.
   * @default - Duration.seconds(60)
   * */
  readonly timeout?: Duration;

  /**
   * Custom lambda execution role.
   *
   * @default - auto generated role.
   */
  readonly role?: iam.IRole;
}

export interface RunOps {
  /**
   * whether to run the lambda function again on the provider update
   *
   * @default false;
   */
  readonly runOnUpdate?: boolean;
}

export class BashExecFunction extends Construct {
  readonly handler: lambda.DockerImageFunction;
  constructor(scope: Construct, id: string, props: BashExecFunctionProps) {
    super(scope, id);

    if (props?.dockerfile && fs.existsSync(props?.dockerfile)) {
      // Copy your Dockerfile to Dockerfile.custom.
      fs.copyFileSync(props?.dockerfile, path.join(__dirname, '../docker.d/Dockerfile.custom'));
    }
    const dockerDirPath = path.join(__dirname, '../docker.d');
    const scriptPath = props.script;

    // copy the user script to the docker.d directory as main.sh so we can bundle it up into a new docker image
    const mainFile = path.join(dockerDirPath, '/main.sh');
    fs.copyFileSync(scriptPath, mainFile);

    this.handler = new lambda.DockerImageFunction(this, 'BashExecFunction', {
      code: lambda.DockerImageCode.fromImageAsset(dockerDirPath, {
        file: props?.dockerfile && fs.existsSync(props?.dockerfile) ? 'Dockerfile.custom': undefined,
      }),
      timeout: props.timeout ?? Duration.seconds(60),
      logRetention: logs.RetentionDays.ONE_DAY,
      environment: props.environment,
      role: props.role,
    });
    new CfnOutput(this, 'LogGroup', { value: this.handler.logGroup.logGroupName });
  }
  public run(ops: RunOps = {}): CustomResource {
    const onEvent = new lambda.DockerImageFunction(this, 'OnEventHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker.d'), {
        cmd: ['function.sh.onEvent'],
      }),
      environment: {
        LAMBDA_FUNCTION_ARN: this.handler.functionArn,
      },
      timeout: Duration.minutes(5),
    });
    const myProvider = new cr.Provider(this, 'MyProvider', {
      onEventHandler: onEvent,
    });

    const staging = new AssetStaging(this, 'Staging', {
      sourcePath: path.join(__dirname, '../docker.d'),
    });

    const resource = new CustomResource(this, 'RunLambdaBash', {
      resourceType: 'Custom::RunLambdaBash',
      serviceToken: myProvider.serviceToken,
      properties: {
        assetHash: ops.runOnUpdate ? staging.assetHash : undefined,
      },
    });
    this.handler.grantInvoke(onEvent.grantPrincipal);

    return resource;
  }

}
