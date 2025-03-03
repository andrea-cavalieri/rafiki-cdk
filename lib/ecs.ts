import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import {
  SecurityGroup,
  Port,
  Connections,
  InstanceType,
  SubnetType,
  LaunchTemplate,
  UserData,
  IVpc,
  Peer,
} from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ContainerImage,
  LogDrivers,
  AsgCapacityProvider,
  EcsOptimizedImage,
  Ec2Service,
  Ec2TaskDefinition,
  NetworkMode,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationLoadBalancer,
  ApplicationTargetGroup,
  ApplicationProtocol,
  Protocol,
  ListenerAction,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ServicePrincipal, Role, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface ECSResourcesProps {
  vpc: IVpc;
}
export class ECSStack extends Stack {
  public ecsResources: ECSResources;
  constructor(scope: Construct, id: string, _props: StackProps, vpc: IVpc) {
    super(scope, id);

   
    // Create ECS resources
    const ecsResources = new ECSResources(this, 'ECSResources', {
      vpc: vpc,   
    });

    this.ecsResources = ecsResources;
  }
}


export class ECSResources extends Construct {
  public cluster: Cluster;
  public applicationLoadBalancer: ApplicationLoadBalancer;


  constructor(scope: Construct, id: string, props: ECSResourcesProps) {
    super(scope, id);

    //Step 1: Create an ECS Cluster
    this.cluster = new Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'websocket-service',
    });


    //Step 2: Create an IAM Role for ECS Instances
    const ecsInstanceRole = new Role(this, 'EcsInstanceRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
      ],
    });


    //Step 3: Define User Data Script for ECS Agent
    const userData = UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      `echo ECS_CLUSTER=${this.cluster.clusterName} >> /tmp/ecs.config`,
    );


    // Create Security Group for ALB
    const launchTemplateSecurityGroup = new SecurityGroup(this, 'LaunchTemplateSecurityGroup', {
      vpc: props.vpc,
      description: 'Security Group for EC2 cluster',
      allowAllOutbound: true,
    });

    //Step 4: Create a Launch Template (with IAM Role)
    const launchTemplate = new LaunchTemplate(this, 'EcsLaunchTemplate', {
      instanceType: new InstanceType('t3.micro'),
      machineImage: EcsOptimizedImage.amazonLinux2(),
      role: ecsInstanceRole, // Assign IAM role
      securityGroup: launchTemplateSecurityGroup,
      userData,
    });

    const autoScalingGroup = new AutoScalingGroup(this, 'AutoScalingGroup', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      launchTemplate: launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      newInstancesProtectedFromScaleIn: false,
    });

    autoScalingGroup.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    autoScalingGroup.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
    });

    const capacityProvider = new AsgCapacityProvider(this, 'capacityProvider', {
      autoScalingGroup: autoScalingGroup,
    });

    this.cluster.addAsgCapacityProvider(capacityProvider);


    // Create Security Group for ALB
    const albSecurityGroup = new SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: props.vpc,
      description: 'Security Group for ALB',
      allowAllOutbound: true,
    });

    // Create Security Group for WebSocket Service
    const webSocketServiceSecurityGroup = new SecurityGroup(
      this,
      'webSocketServiceSecurityGroup',
      { vpc: props.vpc, allowAllOutbound: true },
    );

    webSocketServiceSecurityGroup.connections.allowFrom(
      new Connections({
        securityGroups: [albSecurityGroup],
      }),
      Port.tcp(8080),
      'allow traffic on port 8080 from the ALB security group',
    );

    // Create a WebSocket Service
    const websocketServiceRole = new Role(this, 'WebSocketServiceRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const webSocketTask = new Ec2TaskDefinition(
      this,
      'WebSocketTaskDefinition',
      {
        taskRole: websocketServiceRole,
        networkMode: NetworkMode.AWS_VPC, // Change to AWS_VPC mode
      },
    );

    webSocketTask.addContainer('WebSocketContainer', {
      image: ContainerImage.fromAsset('lib/resources/containerImage'),
      containerName: 'websocket-service',
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8080, hostPort: 8080 }],
      logging: LogDrivers.awsLogs({
        streamPrefix: 'websocket-service',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/health'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(30),
      },
      environment: {},
    });
 

    // Create Service
    const websocketService = new Ec2Service(this, 'WebSocketService', {
      cluster: this.cluster,
      taskDefinition: webSocketTask,
      desiredCount: 1,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [webSocketServiceSecurityGroup],
      assignPublicIp: false,
    });

    const scalableTarget = websocketService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 1,
    });

    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
    });
    

    const webSocketTargetGroup = new ApplicationTargetGroup(
      this,
      'webSocketTargetGroup',
      {
        vpc: props.vpc,
        port: 8080,
        protocol: ApplicationProtocol.HTTP,
        targets: [websocketService],
        healthCheck: {
          path: '/',
          protocol: Protocol.HTTP,
          port: '8080',
        },
      },
    );

    
    this.applicationLoadBalancer = new ApplicationLoadBalancer(
      this,
      'ApplicationLoadBalancer',
      {
        vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        vpc: props.vpc,
        internetFacing: false,
        securityGroup: albSecurityGroup,
      },
    );


    // Create Listener
    this.applicationLoadBalancer.addListener(
      'webSocketListener',
      {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        open: true,
        defaultAction: ListenerAction.forward([webSocketTargetGroup]),
      },
    );
   
  }
}
