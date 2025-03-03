import { Stack, StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  PriceClass,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { VpcOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

interface DistributionResourcesProps {
  applicationLoadBalancer: ApplicationLoadBalancer;
}


export class DistributionStack extends Stack {
  constructor(scope: Construct, id: string, _props: StackProps, props: DistributionResourcesProps) { 
    super(scope, id);
    new DistributionResources(
      this,
      'DistributionResources',
      props,
    );
  }
}



export class DistributionResources extends Construct {
  public distribution: Distribution;

  constructor(scope: Construct, id: string, props: DistributionResourcesProps) {
    super(scope, id);

    // const distributionLoggingBucket = new Bucket(
    //   this,
    //   'DistributionLoggingBucket',
    //   {
    //     publicReadAccess: false,
    //     removalPolicy: RemovalPolicy.DESTROY,
    //     autoDeleteObjects: true,
    //     encryption: BucketEncryption.S3_MANAGED,
    //     objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
    //   },
    // );


    this.distribution = new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: VpcOrigin.withApplicationLoadBalancer(props.applicationLoadBalancer),
        viewerProtocolPolicy: ViewerProtocolPolicy.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
      },
      defaultRootObject: 'index.html',
      priceClass: PriceClass.PRICE_CLASS_100,
      //logBucket: distributionLoggingBucket,
      enableLogging: false,
    });
  }
}
