import models from '../database/models';
import {
  imageUpload,
  serverResponse,
  serverError,
  articleResponse,
  isFollowing
} from '../helpers';
import Tags from './Tags';
import middlewares from '../middlewares';

const {
  Article,
  Like,
  Dislike,
  Category,
  Comment,
  Tag,
  User,
  UserFollower
} = models;
const { verifyToken, getSessionFromToken } = middlewares;

/**
 * Returns server response for the article like/dislike operation
 *
 * @name customArticleResponse
 * @param {Object} res - ExpressJS response object
 * @param {Number} statusCode - Response status code
 * @param {String} slug - Article slug
 * @param {String|Number} userId - Id of the user
 * @param {String} userAction - Action user wants to perform (like/dislike)
 * @param {String} message - Custom response message for the client
 * @returns {JSON} JSON object with details of the liked/disliked article
 */
const customArticleResponse = async (
  res,
  statusCode,
  slug,
  userId,
  userAction,
  message
) => {
  const includeLikeOrDislike = userAction === 'like'
    ? [{ model: Like, as: 'likes', where: { userId } }]
    : [{ model: Dislike, as: 'dislikes', where: { userId } }];

  const article = userAction === 'removeLikeOrDislike'
    ? await Article.findOne({
      where: { slug }
    })
    : await Article.findOne({
      where: { slug },
      include: includeLikeOrDislike
    });

  return serverResponse(res, statusCode, {
    message,
    article
  });
};

/**
 * Create like or dislike for an article
 *
 * @name createLikeOrDislike
 * @param {String} userAction - Action user wants to perform (like/dislike)
 * @param {String|Number} userId - Id of the user
 * @param {Object} article - selected article object
 * @returns {JSON} JSON object with details of the liked/disliked article
 */
const createLikeOrDislike = async (userAction, userId, article) => {
  const articleIdFilter = { where: { id: article.id } };
  const model = userAction === 'like' ? Dislike : Like;
  await model.destroy({
    where: {
      userId,
      contentType: 'article',
      contentId: article.id
    }
  });

  if (userAction === 'like') {
    const dislikesCount = await article.countDislikes();
    await Article.update({ dislikesCount }, { where: { id: article.id } });

    await article.createLike({ userId });
    const likesCount = await article.countLikes();
    await Article.update({ likesCount }, articleIdFilter);
  } else {
    const likesCount = await article.countLikes();
    await Article.update({ likesCount }, articleIdFilter);

    await article.createDislike({ userId });
    const dislikesCount = await article.countDislikes();
    await Article.update({ dislikesCount }, articleIdFilter);
  }
};

/**
 * @export
 * @class Articles
 */ class Articles {
  /**
   * @name createArticle
   * @async
   * @static
   * @memberof Articles
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} JSON object with details of new article
   */
  static async createArticle(req, res) {
    try {
      let image;
      const {
        file,
        body,
        user: { id }
      } = req;
      const { status, articleBody } = body;
      let { category } = body;
      category = category.toLowerCase();
      let { tags } = body;
      const publishedAt = status === 'draft' || articleBody === undefined ? null : Date.now();
      let createTags;
      let categoryDetails = await Category.findOne({
        where: { name: category }
      });
      if (categoryDetails === null) {
        categoryDetails = await Category.findOne({
          where: { name: 'other' }
        });
      }
      if (categoryDetails.name === 'other' && category !== 'other') tags += `,${category}`;
      if (tags) {
        createTags = await Tags.create(tags);
        const error = Articles.canTag(createTags);
        if (error) return serverResponse(res, error.status, error.message);
      }
      if (file) image = await imageUpload(req);

      const myArticle = await Article.create({
        ...body,
        image,
        authorId: id,
        publishedAt,
        categoryId: categoryDetails.id
      });
      const associateTags = (await Tags.associateArticle(myArticle.id, createTags)) || [];
      myArticle.dataValues.tagList = associateTags;
      myArticle.dataValues.category = {
        id: myArticle.categoryId,
        name: categoryDetails.name
      };
      delete myArticle.dataValues.categoryId;
      return serverResponse(res, 200, myArticle.dataValues);
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   * @name canTag
   * @async
   * @static
   * @memberof Articles
   * @param {Array} tagArray array of tags
   * @returns {Object} response object
   */
  static canTag(tagArray) {
    if (tagArray === false) {
      return {
        status: 400,
        message: {
          error:
            'tags cannot be more than 15 and each tag must be more than a character'
        }
      };
    }
    if (tagArray === null || tagArray.length < 1 || !tagArray[0].id) {
      return {
        status: 400,
        message: {
          error: 'tags should be an array of valid strings'
        }
      };
    }
  }

  /**
   * Adds like to an article
   *
   * @name addLike
   * @async
   * @static
   * @memberof Articles
   * @param { Object } req express request object
   * @param { Object } res express response object
   * @returns { JSON } Details of the article and the like / dislike object
   */
  static async addLike(req, res) {
    const { id: userId } = req.user;
    const { slug } = req.params;

    try {
      const article = await Article.findBySlug(slug);
      if (!article) {
        return serverResponse(res, 404, { error: 'article not found' });
      }

      const previousArticleLikes = await article.getLikes({
        where: { userId }
      });
      if (previousArticleLikes.length) {
        return serverResponse(res, 200, {
          message: 'you have already liked this article'
        });
      }

      await createLikeOrDislike('like', userId, article);
      customArticleResponse(
        res,
        201,
        slug,
        userId,
        'like',
        'like added successfully'
      );
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   * Adds like or dislike to an article
   * Adds dislike to an article
   *
   * @name addDislike
   * @async
   * @static
   * @memberof Articles
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} Details of the article and the like/dislike object
   */
  static async addDislike(req, res) {
    const { id: userId } = req.user;
    const { slug } = req.params;

    try {
      const article = await Article.findBySlug(slug);
      if (!article) {
        return serverResponse(res, 404, { error: 'article not found' });
      }

      const previousArticleDislikes = await article.getDislikes({
        where: { userId }
      });
      if (previousArticleDislikes.length) {
        return serverResponse(res, 200, {
          message: 'you have already disliked this article'
        });
      }

      await createLikeOrDislike('dislike', userId, article);
      customArticleResponse(
        res,
        201,
        slug,
        userId,
        'dislike',
        'dislike added successfully'
      );
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   * Removes like from an article
   *
   * @name removeLike
   * @async
   * @static
   * @memberof Articles
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} Details of the article and the like/dislike object
   */
  static async removeLike(req, res) {
    const { id: userId } = req.user;
    const { slug } = req.params;

    try {
      const article = await Article.findBySlug(slug);
      if (!article) {
        return serverResponse(res, 404, { error: 'article not found' });
      }

      const articleIdFilter = { where: { id: article.id } };
      const likeOrDislikeRemovalFilter = {
        where: {
          userId,
          contentType: 'article',
          contentId: article.id
        }
      };

      await Like.destroy(likeOrDislikeRemovalFilter);
      const likesCount = await article.countLikes();
      await Article.update({ likesCount }, articleIdFilter);

      customArticleResponse(
        res,
        200,
        slug,
        userId,
        'removeLikeOrDislike',
        'like removed successfully'
      );
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   * Removes dislike from an article
   *
   * @name removeDislike
   * @async
   * @static
   * @memberof Articles
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} Details of the article and the like/dislike object
   */
  static async removeDislike(req, res) {
    const { id: userId } = req.user;
    const { slug } = req.params;

    try {
      const article = await Article.findBySlug(slug);
      if (!article) {
        return serverResponse(res, 404, { error: 'article not found' });
      }

      const articleIdFilter = { where: { id: article.id } };
      const likeOrDislikeRemovalFilter = {
        where: {
          userId,
          contentType: 'article',
          contentId: article.id
        }
      };

      await Dislike.destroy(likeOrDislikeRemovalFilter);
      const dislikesCount = await article.countDislikes();
      await Article.update({ dislikesCount }, articleIdFilter);

      customArticleResponse(
        res,
        200,
        slug,
        userId,
        'removeLikeOrDislike',
        'dislike removed successfully'
      );
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   * update an article
   *
   * @name update
   * @async
   * @static
   * @memberof Articles
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} Details of the article and the updated
   */
  static async update(req, res) {
    try {
      let image;
      const {
        file,
        body,
        user: { id }
      } = req;
      if (Object.keys(body).length === 0) {
        serverResponse(res, 422, { error: 'request body should not be empty' });
      }
      let { category } = body;
      let { tags } = body;
      let categoryDetails;
      const { slug } = req.params;
      const articleDetails = await Article.findBySlug(slug);
      if (articleDetails === null || articleDetails.isArchived) {
        return serverResponse(res, 404, { error: 'article not found' });
      }
      if (category) {
        category = category.toLowerCase();
        categoryDetails = await Category.findOne({
          where: { name: category }
        });
        if (categoryDetails === null) {
          categoryDetails = await Category.findOne({
            where: { name: 'other' }
          });
        }
        if (categoryDetails.name === 'other' && category !== 'other') tags += `,${category}`;
        articleDetails.categoryId = categoryDetails.id;
      }
      let createTags;
      if (tags) {
        createTags = await Tags.create(tags);
        const error = Articles.canTag(createTags);
        if (error) return serverResponse(res, error.status, error.message);
        await Tags.associateArticle(articleDetails.id, createTags);
      }
      if (file) image = await imageUpload(req);
      const { status, articleBody } = body;
      const publishedAt = status === 'draft' || articleBody === undefined ? null : Date.now();
      const updated = await Article.update(
        {
          ...body,
          publishedAt,
          image,
          categoryId: articleDetails.categoryId
        },
        { where: { slug, authorId: id }, returning: true }
      );
      if (!updated[0]) {
        return serverResponse(res, 403, { message: 'article not updated' });
      }
      const updatedArticle = updated[1][0].dataValues;
      const aritcleCategory = await articleDetails.getCategory();
      const updatedTags = await articleDetails.getTags();
      updatedArticle.tagList = updatedTags.map(({ name }) => name);
      updatedArticle.category = aritcleCategory;
      return serverResponse(res, 200, { ...updatedArticle });
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   * gets all author's article
   *
   * @name userArticles
   * @async
   * @static
   * @memberof Articles
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} Details of the users article
   */
  static async userArticles(req, res) {
    try {
      const userArticle = await Article.findAndCountAll({
        where: {
          authorId: req.user.id
        }
      });
      const articles = {
        total: userArticle.count,
        data: userArticle.rows
      };
      res.status(200).send({
        articles
      });
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   *
   * @name viewArticle
   * @async
   * @static
   * @memberof Articles
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} Details of the article and the updated
   */
  static async viewArticle(req, res) {
    try {
      const {
        params: { slug },
        headers: { authorization }
      } = req;
      const article = await Article.findOne({
        where: { slug },
        include: [
          { model: Category, attributes: ['name'] },
          {
            model: User,
            as: 'Author',
            attributes: ['id', 'firstName', 'lastName', 'userName', 'avatarUrl']
          },
          'tags',
          {
            model: Comment,
            as: 'comments',
            include: [
              {
                model: User,
                as: 'author',
                attributes: [
                  'id',
                  'firstName',
                  'lastName',
                  'userName',
                  'avatarUrl'
                ]
              }
            ]
          },
          {
            model: Like,
            as: 'likes',
            include: [{ model: User, attributes: ['userName', 'avatarUrl'] }]
          },
          {
            model: Dislike,
            as: 'dislikes',
            include: [{ model: User, attributes: ['userName', 'avatarUrl'] }]
          }
        ]
      });

      if (authorization) {
        return verifyToken(req, res, () => getSessionFromToken(req, res, () => Articles.authView(req, res, article)));
      }
      if (!article || article.isArchived || !article.publishedAt) {
        return serverResponse(res, 404, { error: 'article not found' });
      }

      await Article.update({ views: article.views + 1 }, { where: { slug } });
      await article.dataValues.comments.map(async ({ dataValues }) => {
        dataValues.following = await isFollowing(
          article.Author.id,
          dataValues.author.id
        );
        return dataValues;
      });
      return articleResponse(res, 200, article);
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   * @name authView
   * @description allows a user to view their own article
   * @param {object} req
   * @param {object} res
   * @param {object} article
   * @returns {json} the json response returned by the server
   * @memberof ProfilesController
   */
  static authView(req, res, article) {
    const {
      user: { id: userId }
    } = req;

    if (article && userId === article.authorId) {
      return serverResponse(res, 200, { article });
    }
    if (!article || article.isArchived || !article.publishedAt) {
      return serverResponse(res, 404, { error: 'article not found' });
    }
    return articleResponse(res, 200, article);
  }
}

export default Articles;
